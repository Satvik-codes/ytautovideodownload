import {
  ALL_FORMATS,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
} from 'mediabunny';
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { StreamDescriptor, VideoInfo } from '../types/video';
import { getApiUrl } from '../config/api';
import { readBody, safeFilename, saveBlob } from './save-file';

// Matches the server's MAX_RELAY_CHUNK_BYTES: every relay request is bounded,
// so no single HTTP request runs long enough to hit the host's timeout
const CHUNK_BYTES = 4 * 1024 * 1024;

export class StreamExpiredError extends Error {
  constructor() {
    super('Stream links expired.');
  }
}

const streamUrl = (stream: StreamDescriptor) =>
  getApiUrl(`/api/video/stream?token=${encodeURIComponent(stream.token)}`);

/**
 * A fetch that serves open-ended `Range: bytes=N-` reads (as issued by
 * mediabunny's UrlSource) by chaining bounded chunk requests into one body.
 */
const chunkedFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const match = /^bytes=(\d+)-(\d*)$/.exec(headers.get('Range') || 'bytes=0-');
  const start = match ? Number(match[1]) : 0;
  const requestedEnd = match && match[2] ? Number(match[2]) : Infinity;

  const fetchChunk = async (from: number) => {
    const chunkHeaders = new Headers(headers);
    chunkHeaders.set('Range', `bytes=${from}-${Math.min(from + CHUNK_BYTES - 1, requestedEnd)}`);
    const res = await fetch(input, { ...init, headers: chunkHeaders });
    if (res.status === 410) throw new StreamExpiredError();
    if (res.status !== 206 || !res.body) throw new Error(`Stream request failed (${res.status})`);
    const contentRange = res.headers.get('Content-Range') || '';
    const end = Number(/bytes \d+-(\d+)/.exec(contentRange)?.[1]);
    const total = Number(/\/(\d+)$/.exec(contentRange)?.[1]);
    if (!Number.isFinite(end) || !Number.isFinite(total)) {
      throw new Error('Stream response missing Content-Range.');
    }
    return { res, end, total };
  };

  const first = await fetchChunk(start);
  const lastByte = Math.min(requestedEnd, first.total - 1);
  let next = first.end + 1;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = first.res.body!.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (next > lastByte) {
            controller.close();
            return;
          }
          const chunk = await fetchChunk(next);
          next = chunk.end + 1;
          reader = chunk.res.body!.getReader();
        }
        const { value, done } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });

  return new Response(body, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${lastByte}/${first.total}`,
      'Content-Length': String(lastByte - start + 1),
      'Content-Type': first.res.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
};

const openInput = (stream: StreamDescriptor, signal: AbortSignal) =>
  new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(streamUrl(stream), {
      fetchFn: (input, init) =>
        chunkedFetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        }),
      getRetryDelay: () => null,
    }),
  });

/**
 * Downloads the selected streams through the server's relay and builds the
 * MP4 in the browser: video and audio packets are copied into a new container
 * without re-encoding, so the server never runs ffmpeg or holds the file.
 */
export async function downloadInBrowser(
  video: VideoInfo,
  height: number | undefined,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const streams = video.streams;
  if (!streams) throw new Error('No browser-downloadable streams.');

  const videoStream = streams.videos?.find((s) => s.height === height) ?? streams.video;
  const blob =
    videoStream && streams.audio
      ? await muxStreams(videoStream, streams.audio, video.duration, signal, onProgress)
      : streams.progressive
        ? await fetchWhole(streams.progressive, signal, onProgress)
        : null;
  if (!blob) throw new Error('No browser-downloadable streams.');

  saveBlob(blob, `${safeFilename(video.title)}.mp4`);
  onProgress(1);
}

/**
 * X serves public single-file MP4s from its CDN with CORS enabled, so the
 * browser fetches the file directly: no relay, no muxing, no server load.
 * Content-Range isn't exposed cross-origin, so it's one whole-file request.
 */
export async function downloadDirect(
  video: VideoInfo,
  height: number | undefined,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const stream = video.streams?.directs?.find((s) => s.height === height) ?? video.streams?.direct;
  if (!stream) throw new Error('No direct stream.');

  // video.twimg.com rejects requests whose Referer is another site (hotlink
  // protection) but accepts ones without a Referer
  const res = await fetch(stream.url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Direct download failed (${res.status})`);

  const blob = await readBody(res, 'video/mp4', stream.size, onProgress);
  saveBlob(blob, `${safeFilename(video.title)}.mp4`);
  onProgress(1);
}

/**
 * M4A without server work: the AAC stream comes through the relay and its
 * packets are repackaged into a plain (non-fragmented) M4A, no re-encoding.
 */
export async function downloadAudioInBrowser(
  video: VideoInfo,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const stream = video.streams?.audio;
  if (!stream) throw new Error('No browser-downloadable audio stream.');

  const input = openInput(stream, signal);
  let output: Output | null = null;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track?.codec) throw new Error('Unsupported audio codec.');

    const target = new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const source = new EncodedAudioPacketSource(track.codec);
    output.addAudioTrack(source);
    await output.start();
    await copyPackets(track, source, signal, (t) => video.duration > 0 && onProgress(Math.min(t / video.duration, 0.99)));
    await output.finalize();

    if (!target.buffer) throw new Error('Packaging produced no output.');
    saveBlob(new Blob([target.buffer], { type: 'audio/mp4' }), `${safeFilename(video.title)}.m4a`);
    onProgress(1);
  } catch (err) {
    await cancelOutput(output);
    throw err;
  } finally {
    input.dispose();
  }
}

async function muxStreams(
  videoStream: StreamDescriptor,
  audioStream: StreamDescriptor,
  duration: number,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const videoInput = openInput(videoStream, signal);
  const audioInput = openInput(audioStream, signal);
  let output: Output | null = null;
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const audioTrack = await audioInput.getPrimaryAudioTrack();
    if (!videoTrack?.codec || !audioTrack?.codec) throw new Error('Unsupported stream codecs.');

    const target = new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();

    // Pump both tracks concurrently; add() backpressure keeps them interleaved
    await Promise.all([
      copyPackets(videoTrack, videoSource, signal, (t) => duration > 0 && onProgress(Math.min(t / duration, 0.99))),
      copyPackets(audioTrack, audioSource, signal),
    ]);
    await output.finalize();

    if (!target.buffer) throw new Error('Muxing produced no output.');
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (err) {
    await cancelOutput(output);
    throw err;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
}

async function copyPackets(
  track: InputVideoTrack | InputAudioTrack,
  source: EncodedVideoPacketSource | EncodedAudioPacketSource,
  signal: AbortSignal,
  onTimestamp?: (seconds: number) => void,
) {
  const decoderConfig = await track.getDecoderConfig();
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    signal.throwIfAborted();
    // The first packet carries the decoder config the muxer needs for the track header
    const meta = first && decoderConfig ? { decoderConfig } : undefined;
    if (source instanceof EncodedVideoPacketSource) {
      await source.add(packet, meta as EncodedVideoChunkMetadata | undefined);
    } else {
      await source.add(packet, meta as EncodedAudioChunkMetadata | undefined);
    }
    first = false;
    onTimestamp?.(packet.timestamp);
  }
  source.close();
}

/** Single-file (progressive) stream: no muxing, just chunked download. */
async function fetchWhole(
  stream: StreamDescriptor,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
) {
  const res = await chunkedFetch(streamUrl(stream), { headers: { Range: 'bytes=0-' }, signal });
  return readBody(res, 'video/mp4', stream.size, onProgress);
}

/** Stops a half-written output so mediabunny releases its buffers. */
async function cancelOutput(output: Output | null) {
  if (output && output.state !== 'finalized' && output.state !== 'canceled') {
    await output.cancel().catch(() => {});
  }
}
