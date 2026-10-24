# Runs the full SQL pipeline (00 -> 06) from the project root.
# Usage:  powershell -ExecutionPolicy Bypass -File .\run_all.ps1

Set-Location $PSScriptRoot

if (-not (Test-Path "data\DataCoSupplyChainDataset.csv")) {
    Write-Host "data\DataCoSupplyChainDataset.csv not found. See docs\windows_setup.md, step 3." -ForegroundColor Red
    exit 1
}

if (-not $env:PGPASSWORD) {
    $secure = Read-Host "Password for PostgreSQL user 'postgres'" -AsSecureString
    $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

New-Item -ItemType Directory -Force -Path results | Out-Null

$steps = @(
    @{ File = "sql/00_setup_database.sql";    Db = "postgres"; Out = $null },
    @{ File = "sql/01_load_raw.sql";          Db = "dataco";   Out = $null },
    @{ File = "sql/02_profile_raw.sql";       Db = "dataco";   Out = "results/02_profile_output.txt" },
    @{ File = "sql/03_build_warehouse.sql";   Db = "dataco";   Out = $null },
    @{ File = "sql/04_validate_warehouse.sql"; Db = "dataco";  Out = "results/04_validation_output.txt" },
    @{ File = "sql/05_kpi_views.sql";         Db = "dataco";   Out = $null },
    @{ File = "sql/06_business_analysis.sql"; Db = "dataco";   Out = "results/06_analysis_output.txt" }
)

foreach ($s in $steps) {
    Write-Host "Running $($s.File) ..." -ForegroundColor Cyan
    $psqlArgs = @("-U", "postgres", "-d", $s.Db, "-v", "ON_ERROR_STOP=1", "-f", $s.File)
    if ($s.Out) { $psqlArgs += @("-o", $s.Out) }
    & psql @psqlArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$($s.File) failed (exit code $LASTEXITCODE). Fix the error above and re-run." -ForegroundColor Red
        exit 1
    }
}

$failed = Select-String -Path "results/04_validation_output.txt" -Pattern "FAIL"
if ($failed) {
    Write-Warning "Some validation checks FAILED. Open results/04_validation_output.txt."
} else {
    Write-Host "All validation checks passed." -ForegroundColor Green
}
Write-Host "Done. Analysis results: results/06_analysis_output.txt" -ForegroundColor Green
