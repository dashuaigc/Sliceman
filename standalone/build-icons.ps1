param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$source = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\src\icons\pluginIcon@2x.png'))

function New-IconImage([int]$Size, [bool]$Uninstall) {
    $bitmap = New-Object Drawing.Bitmap($Size, $Size)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $g.Clear([Drawing.Color]::Transparent)
        $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        if (-not $Uninstall) {
            $g.DrawImage($source, 0, 0, $Size, $Size)
        } else {
            # Vector artwork: rounded blue S with an orange-red removal badge.
            $g.ScaleTransform(($Size / 256.0), ($Size / 256.0))
            $pen = New-Object Drawing.Pen([Drawing.Color]::FromArgb(36, 145, 246), 30)
            $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
            $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
            try {
                $points = [Drawing.PointF[]]@(
                    [Drawing.PointF]::new(174,47), [Drawing.PointF]::new(48,47),
                    [Drawing.PointF]::new(48,111), [Drawing.PointF]::new(174,111),
                    [Drawing.PointF]::new(174,175), [Drawing.PointF]::new(48,175))
                $g.DrawLines($pen, $points)
            } finally { $pen.Dispose() }
            $badge = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(236, 90, 56))
            $ring = New-Object Drawing.Pen([Drawing.Color]::White, 7)
            $minus = New-Object Drawing.Pen([Drawing.Color]::White, 10)
            $minus.StartCap = $minus.EndCap = [Drawing.Drawing2D.LineCap]::Round
            try {
                $g.FillEllipse($badge, 145, 145, 96, 96)
                $g.DrawEllipse($ring, 145, 145, 96, 96)
                $g.DrawLine($minus, 170, 193, 216, 193)
            } finally { $badge.Dispose(); $ring.Dispose(); $minus.Dispose() }
        }
    } finally { $g.Dispose() }
    return ,$bitmap
}

function Write-MultiSizeIcon([string]$Name, [bool]$Uninstall) {
    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $images = @()
    foreach ($size in $sizes) {
        $bitmap = New-IconImage $size $Uninstall
        $stream = New-Object IO.MemoryStream
        try {
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $images += ,$stream.ToArray()
            if ($size -eq 256) { $bitmap.Save((Join-Path $OutputDirectory ($Name + '.png')), [Drawing.Imaging.ImageFormat]::Png) }
        } finally { $bitmap.Dispose(); $stream.Dispose() }
    }
    $file = [IO.File]::Create((Join-Path $OutputDirectory ($Name + '.ico')))
    $writer = New-Object IO.BinaryWriter($file)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
            $offset += $images[$i].Length
        }
        foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
    } finally { $writer.Dispose(); $file.Dispose() }
}
try {
    Write-MultiSizeIcon 'install' $false
    Write-MultiSizeIcon 'uninstall' $true
} finally { $source.Dispose() }
