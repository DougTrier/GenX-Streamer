$ErrorActionPreference = 'Stop'
$tmgRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tmgSource = Join-Path $tmgRepo 'assets/tmg-retro-tv.png'
$tmgArtworkHash = (Get-FileHash -LiteralPath $tmgSource -Algorithm SHA256).Hash
$tmgOutputs = @('src-tauri/icons/android/drawable-xhdpi/tv_banner.png', 'src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png')
Add-Type -AssemblyName System.Drawing
$tmgImage = [System.Drawing.Image]::FromFile($tmgSource)
$tmgCanvas = [System.Drawing.Bitmap]::new(320,180,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tmgGraphics = [System.Drawing.Graphics]::FromImage($tmgCanvas)
$tmgFont = [System.Drawing.Font]::new('Arial',21,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
$tmgBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
try {
    $tmgGraphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#111827'))
    $tmgGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $tmgGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $tmgGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $tmgGraphics.DrawImage($tmgImage,[System.Drawing.Rectangle]::new(12,16,148,148))
    $tmgGraphics.DrawString('GenX',$tmgFont,$tmgBrush,[System.Drawing.PointF]::new(170,62))
    $tmgGraphics.DrawString('Streamer',$tmgFont,$tmgBrush,[System.Drawing.PointF]::new(170,90))
    foreach ($tmgRelative in $tmgOutputs) {
        $tmgOutput = Join-Path $tmgRepo $tmgRelative
        New-Item -ItemType Directory -Path (Split-Path $tmgOutput -Parent) -Force | Out-Null
        $tmgCanvas.Save($tmgOutput,[System.Drawing.Imaging.ImageFormat]::Png)
    }
} finally {
    $tmgBrush.Dispose(); $tmgFont.Dispose(); $tmgGraphics.Dispose(); $tmgCanvas.Dispose(); $tmgImage.Dispose()
}
if ((Get-FileHash -LiteralPath $tmgSource -Algorithm SHA256).Hash -ne $tmgArtworkHash) { throw 'GX artwork changed while generating TV banner' }
if ((Get-FileHash -LiteralPath (Join-Path $tmgRepo $tmgOutputs[0])).Hash -ne (Get-FileHash -LiteralPath (Join-Path $tmgRepo $tmgOutputs[1])).Hash) { throw 'Selected TV banner does not match generated artwork' }
Write-Output "Android TV banner 320x180, GX source SHA256 $tmgArtworkHash"
