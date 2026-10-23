# Rasterize the Termlo vector mark for Windows and macOS installer icons.
Add-Type -AssemblyName System.Drawing
$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets'))
$frames = @()
foreach ($dimension in @(16, 32, 48, 64, 128, 256, 512, 1024)) {
    $bitmap = [System.Drawing.Bitmap]::new($dimension, $dimension)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.ScaleTransform($dimension / 256.0, $dimension / 256.0)
    $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $shape.AddArc(8, 8, 108, 108, 180, 90)
    $shape.AddArc(140, 8, 108, 108, 270, 90)
    $shape.AddArc(140, 140, 108, 108, 0, 90)
    $shape.AddArc(8, 140, 108, 108, 90, 90)
    $shape.CloseFigure()
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#173640'))
    $foreground = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#9FE7CE'))
    $pen = [System.Drawing.Pen]::new($foreground.Color, 17)
    $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.FillPath($background, $shape)
    $graphics.DrawLine($pen, 65, 77, 188, 77)
    $graphics.DrawLine($pen, 126, 77, 126, 178)
    $graphics.DrawLine($pen, 126, 178, 179, 178)
    foreach ($point in @(@(65,77),@(188,77),@(179,178))) { $graphics.FillEllipse($foreground, $point[0]-12, $point[1]-12, 24, 24) }
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    if ($dimension -eq 256) { [System.IO.File]::WriteAllBytes((Join-Path $assetDirectory 'termlo.png'), $bytes) }
    $frames += @{ Size = $dimension; Data = $bytes }
    $stream.Dispose(); $pen.Dispose(); $foreground.Dispose(); $background.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$icoFrames = @($frames | Where-Object { $_.Size -le 256 })
$ico = [System.IO.BinaryWriter]::new([System.IO.File]::Create((Join-Path $assetDirectory 'termlo.ico')))
$ico.Write([UInt16]0); $ico.Write([UInt16]1); $ico.Write([UInt16]$icoFrames.Count)
$offset = 6 + 16 * $icoFrames.Count
foreach ($frame in $icoFrames) {
    $sizeByte = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
    $ico.Write([Byte]$sizeByte); $ico.Write([Byte]$sizeByte)
    $ico.Write([Byte]0); $ico.Write([Byte]0); $ico.Write([UInt16]1); $ico.Write([UInt16]32)
    $ico.Write([UInt32]$frame.Data.Length); $ico.Write([UInt32]$offset)
    $offset += $frame.Data.Length
}
foreach ($frame in $icoFrames) { $ico.Write([Byte[]]$frame.Data) }
$ico.Dispose()
function Write-BigEndian($writer, [uint32]$value) {
    $bytes = [BitConverter]::GetBytes($value)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($bytes) }
    $writer.Write([Byte[]]$bytes)
}
$macFrames = @($frames | Where-Object { $_.Size -in @(16,32,64,128,256,512,1024) })
$types = @{ 16='icp4'; 32='icp5'; 64='icp6'; 128='ic07'; 256='ic08'; 512='ic09'; 1024='ic10' }
$totalLength = 8
foreach ($frame in $macFrames) { $totalLength += $frame.Data.Length + 8 }
$icns = [System.IO.BinaryWriter]::new([System.IO.File]::Create((Join-Path $assetDirectory 'termlo.icns')))
$icns.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
Write-BigEndian $icns ([uint32]$totalLength)
foreach ($frame in $macFrames) {
    $icns.Write([System.Text.Encoding]::ASCII.GetBytes($types[$frame.Size]))
    Write-BigEndian $icns ([uint32]($frame.Data.Length + 8))
    $icns.Write([Byte[]]$frame.Data)
}
$icns.Dispose()
