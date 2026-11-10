# Speech decoder fixtures

These files contain locally generated speech. The video has a black frame.
No source recording is included.

Install `espeak-ng` and `ffmpeg`, then run `bash generate.sh` from this directory.
The script uses the same phrase for both files:

> This is a short English speech sample. Each spoken word has a clear place in time.

The WAV is 7.2 seconds, mono, 16 kHz PCM. The MP4 uses H.264 video and stereo
48 kHz AAC audio. Tests check decoding, codec, duration, and sample shape;
they do not compare recognition text or word timing.

The committed MP4 has 339 audio packets, measured independently with
`ffprobe -select_streams a:0 -count_packets -show_entries stream=nb_read_packets`.
