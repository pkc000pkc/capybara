param(
  [Parameter(Mandatory = $true)]
  [string]$TargetRoot,
  [int]$Parts = 8
)

$ErrorActionPreference = 'Stop'
$uri = 'https://s3.us-west-2.amazonaws.com/appworld.dev/data-0.1.0.bundle'
$totalBytes = 34280074
$target = [System.IO.Path]::GetFullPath($TargetRoot)
$temporary = Join-Path $target '.tmp'
[System.IO.Directory]::CreateDirectory($temporary) | Out-Null
$chunkSize = [math]::Ceiling($totalBytes / $Parts)
$processes = @()

for ($index = 0; $index -lt $Parts; $index += 1) {
  $start = [long]($index * $chunkSize)
  $end = [long]([math]::Min($totalBytes - 1, ($index + 1) * $chunkSize - 1))
  $file = Join-Path $temporary ('data.part{0:D2}' -f $index)
  $arguments = @(
    '-L', '--fail', '--silent', '--show-error', '--retry', '3',
    '--range', "$start-$end", '--output', $file, $uri
  )
  $processes += Start-Process -FilePath 'curl.exe' -ArgumentList $arguments -PassThru -WindowStyle Hidden
}

$processes | Wait-Process
$failed = $processes | Where-Object { $_.ExitCode -ne 0 }
if ($failed) {
  throw "AppWorld range downloads failed: $($failed.Id -join ', ')"
}

$partsFound = Get-ChildItem $temporary -Filter 'data.part*' | Sort-Object Name
if ($partsFound.Count -ne $Parts) {
  throw "Expected $Parts AppWorld bundle parts, found $($partsFound.Count)"
}

$bundle = Join-Path $temporary 'data-0.1.0.bundle'
$output = [System.IO.File]::Create($bundle)
try {
  foreach ($part in $partsFound) {
    $input = [System.IO.File]::OpenRead($part.FullName)
    try {
      $input.CopyTo($output)
    } finally {
      $input.Dispose()
    }
  }
} finally {
  $output.Dispose()
}

$length = (Get-Item $bundle).Length
if ($length -ne $totalBytes) {
  throw "AppWorld bundle size mismatch: expected $totalBytes, found $length"
}

$partsFound | Remove-Item -Force
$python = Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  throw "AppWorld project Python was not found: $python"
}
$unpack = @'
import sys
from appworld.common.constants import PASSWORD, SALT
from appworld.common.utils import unpack_bundle

unpack_bundle(
    bundle_file_path=sys.argv[1],
    base_directory=sys.argv[2],
    password=PASSWORD,
    salt=SALT,
)
'@
& $python -c $unpack $bundle $target
if ($LASTEXITCODE -ne 0) {
  throw "AppWorld data unpack failed with exit code $LASTEXITCODE"
}
Write-Output (Join-Path $target 'data')
