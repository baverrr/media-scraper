# Off-air slate

What the Local Sports channel plays while no local game is on the air (`src/slate.js`): `slate.png`
encoded as one minute of 720p video with silent audio, cut into ten 6-second MPEG-TS segments with
continuous timestamps. The sidecar loops them as a live stream.

To change the picture, edit `slate.png` (1280×720) and re-encode from this folder:

```sh
ffmpeg -loop 1 -framerate 25 -i slate.png -f lavfi -t 59.95 -i anullsrc=channel_layout=stereo:sample_rate=48000 -t 60 \
  -map 0:v -map 1:a -c:v libx264 -preset veryslow -tune stillimage -crf 26 -pix_fmt yuv420p -profile:v main \
  -level 4.0 -g 50 -keyint_min 50 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*2)" -c:a aac -b:a 64k \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  -f hls -hls_time 6 -hls_list_size 0 -hls_segment_type mpegts -hls_segment_filename '%d.ts' slate.m3u8
rm slate.m3u8
```

The silent audio is a little shorter than the video (`-t 59.95` on its input), so it ends before the
next pass starts: audio that runs past the minute would go back in time at every loop.

Keep ten segments of six seconds each, or change `OFF_AIR_SEGMENTS` and `OFF_AIR_SECONDS` in `src/slate.js` to match.
