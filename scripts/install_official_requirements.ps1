param(
  [string]$Python = $env:GAIA2_PYTHON,
  [string]$Target = "$PSScriptRoot\..\.official-python"
)

if (-not $Python) {
  $Python = "python"
}

$requirements = Join-Path $PSScriptRoot '..\requirements-official.txt'
$resolvedRequirements = (Resolve-Path $requirements).Path
New-Item -ItemType Directory -Force -Path $Target | Out-Null
& $Python -m pip install --upgrade --target $Target -r $resolvedRequirements
if ($LASTEXITCODE -ne 0) {
  throw "Official GAIA2 requirements installation failed with exit code $LASTEXITCODE"
}

Write-Output "Installed official GAIA2 requirements into $Target"
