set -e
cd "$(dirname "$0")/../../.video-cache"; mkdir -p enc
for s in s0 s1 s2 s3 s4 s5 s6 s7 s8 s9; do
  n=$(ls frames/$s | wc -l); d=$(echo "scale=3; $n/30" | bc); fi=""
  [ $s = s0 ] && fi=",fade=t=in:st=0:d=0.6"
  [ $s = s9 ] && fi=",fade=t=out:st=$(echo "$d-0.8" | bc):d=0.8"
  ffmpeg -loglevel error -y -framerate 30 -i frames/$s/%05d.jpg -vf "format=yuv420p$fi" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p -r 30 enc/$s.tmp.mp4 && mv enc/$s.tmp.mp4 enc/$s.mp4
done
printf "file '%s'\n" enc/s0.mp4 enc/s1.mp4 enc/s2.mp4 enc/s3.mp4 enc/s4.mp4 enc/s5.mp4 enc/s6.mp4 enc/s7.mp4 enc/s8.mp4 enc/s9.mp4 > list.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -c copy -movflags +faststart thursday-home-4k.tmp.mp4 && mv thursday-home-4k.tmp.mp4 ../docs/img/thursday-home-4k.mp4
ffprobe -v error -show_entries stream=width,height -of compact ../docs/img/thursday-home-4k.mp4
