$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot "android\app\src\main\res"
$ink = [System.Drawing.ColorTranslator]::FromHtml("#111716")
$green = [System.Drawing.ColorTranslator]::FromHtml("#55e39a")
$paper = [System.Drawing.ColorTranslator]::FromHtml("#edf0ed")

function New-Graphics([System.Drawing.Bitmap] $bitmap) {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  return $graphics
}

function New-RoundedRectanglePath([float] $x, [float] $y, [float] $width, [float] $height, [float] $radius) {
  $diameter = $radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Logo([System.Drawing.Graphics] $graphics, [float] $size, [bool] $round) {
  $backgroundBrush = [System.Drawing.SolidBrush]::new($ink)
  try {
    if ($round) {
      $graphics.FillEllipse($backgroundBrush, 0, 0, $size, $size)
    } else {
      $backgroundPath = New-RoundedRectanglePath 0 0 $size $size ($size * 0.1875)
      try { $graphics.FillPath($backgroundBrush, $backgroundPath) } finally { $backgroundPath.Dispose() }
    }
  } finally {
    $backgroundBrush.Dispose()
  }

  $scale = $size / 64
  $pen = [System.Drawing.Pen]::new($green, 6 * $scale)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  try {
    $graphics.DrawBezier($pen, 10 * $scale, 34 * $scale, 16 * $scale, 16 * $scale, 20 * $scale, 52 * $scale, 26 * $scale, 34 * $scale)
    $graphics.DrawBezier($pen, 26 * $scale, 34 * $scale, 32 * $scale, 16 * $scale, 36 * $scale, 52 * $scale, 42 * $scale, 34 * $scale)
    $graphics.DrawBezier($pen, 42 * $scale, 34 * $scale, 48 * $scale, 16 * $scale, 52 * $scale, 52 * $scale, 54 * $scale, 34 * $scale)
  } finally {
    $pen.Dispose()
  }
}

function Save-LauncherIcon([string] $path, [int] $size, [bool] $round) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = New-Graphics $bitmap
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    Draw-Logo $graphics $size $round
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-AdaptiveForeground([string] $path, [int] $size) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = New-Graphics $bitmap
  $scale = $size / 108
  $pen = [System.Drawing.Pen]::new($green, 8 * $scale)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawBezier($pen, 20 * $scale, 58 * $scale, 28 * $scale, 32 * $scale, 34 * $scale, 84 * $scale, 42 * $scale, 58 * $scale)
    $graphics.DrawBezier($pen, 42 * $scale, 58 * $scale, 50 * $scale, 32 * $scale, 56 * $scale, 84 * $scale, 64 * $scale, 58 * $scale)
    $graphics.DrawBezier($pen, 64 * $scale, 58 * $scale, 72 * $scale, 32 * $scale, 80 * $scale, 84 * $scale, 88 * $scale, 58 * $scale)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $pen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-Splash([string] $path) {
  $source = [System.Drawing.Image]::FromFile($path)
  try {
    $width = $source.Width
    $height = $source.Height
  } finally {
    $source.Dispose()
  }

  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = New-Graphics $bitmap
  $logoSize = [math]::Round([math]::Min($width, $height) * 0.22)
  $logo = [System.Drawing.Bitmap]::new($logoSize, $logoSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $logoGraphics = New-Graphics $logo
  try {
    $graphics.Clear($paper)
    $logoGraphics.Clear([System.Drawing.Color]::Transparent)
    Draw-Logo $logoGraphics $logoSize $false
    $left = [math]::Round(($width - $logoSize) / 2)
    $top = [math]::Round(($height - $logoSize) / 2)
    $graphics.DrawImage($logo, $left, $top, $logoSize, $logoSize)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $logoGraphics.Dispose()
    $logo.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$densities = [ordered]@{
  mdpi = 48
  hdpi = 72
  xhdpi = 96
  xxhdpi = 144
  xxxhdpi = 192
}

foreach ($density in $densities.GetEnumerator()) {
  $directory = Join-Path $resourceRoot "mipmap-$($density.Key)"
  Save-LauncherIcon (Join-Path $directory "ic_launcher.png") $density.Value $false
  Save-LauncherIcon (Join-Path $directory "ic_launcher_round.png") $density.Value $true
  Save-AdaptiveForeground (Join-Path $directory "ic_launcher_foreground.png") ([int]($density.Value * 2.25))
}

Get-ChildItem -LiteralPath $resourceRoot -Recurse -Filter "splash.png" | ForEach-Object {
  Save-Splash $_.FullName
}
