# Synthetic media preview

`media-frame-preview.mp4` is generated from FFmpeg's local `testsrc2` source.
It contains a moving test pattern, no source recording, audio, font or caption.
The native decoder and seek contract is H.264 constrained baseline, yuv420p,
640 by 360, one frame per second and 134 seconds. Each frame is independently
seekable, and the MP4 metadata is placed first for range-backed browser reads.
The playback test seeks to 120 seconds; keep the clip longer than that.

Run from the repository root in a Linux bash session with FFmpeg installed:

```bash
bash admin/tests/visual/fixtures/generate-media-frame-preview.sh
ffprobe -v error -show_entries format=duration,size:stream=codec_name,profile,codec_type,width,height,pix_fmt,r_frame_rate,duration,nb_frames -of json admin/tests/visual/fixtures/media-frame-preview.mp4
```

The method was run with FFmpeg 6.1.1. Encoder-version changes can change file
bytes; the decoder, dimensions, frame rate, duration and seek behavior remain
the contract. Use the existing media-refinement, video-viewer-panes and
video-transcript-playback browser cases for behavior proof.
