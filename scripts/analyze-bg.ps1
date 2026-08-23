Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('D:\Sliceman\tmp_analysis.png')
Write-Output ("size: {0}x{1} format: {2}" -f $bmp.Width, $bmp.Height, $bmp.PixelFormat)
$pts = @(
  @(0, 0), @($bmp.Width - 1, 0), @(0, $bmp.Height - 1), @($bmp.Width - 1, $bmp.Height - 1),
  @([int]($bmp.Width / 2), 0), @([int]($bmp.Width / 2), $bmp.Height - 1),
  @(0, [int]($bmp.Height / 2)), @($bmp.Width - 1, [int]($bmp.Height / 2))
)
foreach ($p in $pts) {
  $c = $bmp.GetPixel($p[0], $p[1])
  Write-Output ("({0},{1}): R{2} G{3} B{4}" -f $p[0], $p[1], $c.R, $c.G, $c.B)
}
# 统计接近纯白（三通道都 >= 240）的像素比例
$white = 0; $total = 0
for ($x = 0; $x -lt $bmp.Width; $x += 3) {
  for ($y = 0; $y -lt $bmp.Height; $y += 3) {
    $c = $bmp.GetPixel($x, $y); $total++
    if ($c.R -ge 240 -and $c.G -ge 240 -and $c.B -ge 240) { $white++ }
  }
}
Write-Output ("near-white ratio: {0:P1}" -f ($white / $total))
$bmp.Dispose()
