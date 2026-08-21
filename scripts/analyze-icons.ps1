Add-Type -AssemblyName System.Drawing
$dir = 'D:\Sliceman\src\icons'
foreach ($f in @('icon.png','icon@2x.png','icon-dark.png','icon-light.png')) {
  $p = Join-Path $dir $f
  $bmp = [System.Drawing.Bitmap]::FromFile($p)
  $opaque = 0; $sumR = 0; $sumG = 0; $sumB = 0
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    for ($y = 0; $y -lt $bmp.Height; $y++) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.A -gt 32) { $opaque++; $sumR += $c.R; $sumG += $c.G; $sumB += $c.B }
    }
  }
  if ($opaque -gt 0) {
    $avg = ('{0:N0},{1:N0},{2:N0}' -f ($sumR/$opaque), ($sumG/$opaque), ($sumB/$opaque))
  } else { $avg = '全透明' }
  $cov = [math]::Round(100 * $opaque / ($bmp.Width * $bmp.Height), 1)
  Write-Output ('{0}: {1}x{2} 覆盖率 {3}% 平均色RGB({4})' -f $f, $bmp.Width, $bmp.Height, $cov, $avg)
  $bmp.Dispose()
}
