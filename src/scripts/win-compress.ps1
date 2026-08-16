
$ErrorActionPreference = 'Stop';
Add-Type -AssemblyName System.Drawing;
$img = [System.Drawing.Image]::FromFile($env:TV_COMPRESS_IN);
try {
  $maxEdge = [double]$env:TV_COMPRESS_MAXEDGE;
  $scale = [Math]::Min(1.0, $maxEdge / [Math]::Max([double]$img.Width, [double]$img.Height));
  $nw = [Math]::Max(1, [int]($img.Width * $scale));
  $nh = [Math]::Max(1, [int]($img.Height * $scale));
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh;
  $g = [System.Drawing.Graphics]::FromImage($bmp);
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
  $g.DrawImage($img, 0, 0, $nw, $nh);
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' };
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1);
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L);
  $bmp.Save($env:TV_COMPRESS_OUT, $enc, $params);
  $g.Dispose(); $bmp.Dispose();
} finally { $img.Dispose() }
