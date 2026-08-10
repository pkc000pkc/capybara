param(
  [string]$Project = ".",
  [string]$Root = ".\.venv\appworld-root"
)

$ErrorActionPreference = "Stop"
$projectPath = (Resolve-Path -LiteralPath $Project).Path
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$python = Join-Path $projectPath ".venv\Scripts\python.exe"
$generator = Join-Path $projectPath "scripts\generate_dataset.py"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw "AppWorld Python environment was not found: $python"
}

$datasets = @(
  @{ Split = "train"; Id = "appworld-train-all-scenarios" },
  @{ Split = "test_normal"; Id = "appworld-test-normal-all-scenarios" },
  @{ Split = "test_challenge"; Id = "appworld-test-challenge-all-scenarios" }
)

foreach ($dataset in $datasets) {
  & $python $generator `
    --project $projectPath `
    --root $rootPath `
    --split $dataset.Split `
    --selection scenarios `
    --all `
    --dataset-id $dataset.Id
  if ($LASTEXITCODE -ne 0) {
    throw "Dataset generation failed: $($dataset.Id)"
  }
}

Write-Output "Prepared AppWorld train and closed-book test datasets."
Write-Output "Commit .capybara/datasets.json and all script changes before starting an experiment."
