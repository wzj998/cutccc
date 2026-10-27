export function gpuRotation(video) {
  const side = video.side_data_list?.find(s => s.side_data_type === 'Display Matrix');
  const angle = Number(side?.rotation ?? video.tags?.rotate ?? 0);
  if (!Number.isFinite(angle) || Math.abs(angle / 90 - Math.round(angle / 90)) > .00001) return null;
  if (side?.displaymatrix) {
    const rows = side.displaymatrix.trim().split('\n').map(line => line.split(':')[1]?.trim().split(/\s+/).map(Number));
    if (rows.length < 2 || !rows[0] || !rows[1]) return null;
    const [a,b] = rows[0], [c,d] = rows[1];
    // Mirrored or non-rigid display matrices keep FFmpeg's normal autorotation path.
    if (a*d-b*c <= 0 || Math.abs((a*a+b*b)/65536**2-1)>.001 || Math.abs((c*c+d*d)/65536**2-1)>.001) return null;
  }
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}
export function geometryFilter(width,height,rotation=null) {
  if (rotation === null) return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const swapped = rotation === 90 || rotation === 270;
  const turn = {0:'',90:',transpose=cclock',180:',hflip,vflip',270:',transpose=clock'}[rotation];
  return `scale_cuda=${swapped?height:width}:${swapped?width:height}:force_original_aspect_ratio=decrease:force_divisible_by=2:format=yuv420p:interp_algo=bicubic,hwdownload,format=yuv420p${turn},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}
export function clipVideoFilter(clip,width,height,fps,frames,rotation=null) {
  return `trim=start=0:end=${clip.end-clip.start},setpts=PTS-STARTPTS,fps=${fps},${geometryFilter(width,height,rotation)},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS`;
}
export const GPU_INPUT_ARGS = ['-hwaccel','cuda','-hwaccel_output_format','cuda','-noautorotate','-display_rotation','0'];
