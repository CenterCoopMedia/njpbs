# Video previews

The template creates private, versioned video-preview storage and a bounded processing workflow. It stages an exact source version, inspects media, generates a preview or editor export, and verifies the exact output version. Optional original-copy and transcript-audio helpers remain off without explicit image or function parameters. Set Google identity claims, source buckets, and compute settings before deployment. Preserve the no-public-access, encryption, versioning, least-privilege, and retention controls.

Run the adjacent focused tests before changing a template or worker. Deployment needs separate authorization and configured credentials.

Viewing copies select every source audio track and mix all channels into one
48 kHz stereo AAC track. Stereo and four-channel tracks keep their left/right
pairs. Mono tracks play on both sides. Other known channel counts mix to both
sides so dialogue remains audible. Unknown counts refuse admission. The mix
reserves headroom, normalizes measured loudness to -23 LKFS with ITU-R BS.1770-4,
and applies a -2 dBTP limiter.

Transcription extracts that stereo track unchanged into its normal-speed M4A
input. It cannot recover audio omitted from an older viewing copy. Web MP4 clips
keep the viewing copy's audio level. Original files and editor exports retain
their existing audio behavior.

`qa/test_video_preview_audio.py` generates mono, stereo, four-channel, multiple
mono-track and six-channel fixtures. It checks the generated mix with FFmpeg and
the transcript extractor, including signal present only on channels 3 and 4 and
dialogue on a center channel. A separately authorized service canary must still
verify provider acceptance and playback.

For an existing viewing copy with missing audio, a separately authorized repair
can mix a new stereo track while preserving the video stream and original file,
then upload a new asset through the usual media workflow. Copy the description,
credit and tags; retain the old asset, its placements, transcripts and edits.
Verify sound and transcript words on the new asset. Retry and backfill commands
do not replace ready copies: replacement can invalidate transcript inputs, clips
and public-copy references. In-place regeneration requires a reviewed recovery
method that preserves those consumers.
