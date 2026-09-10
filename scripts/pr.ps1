[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("create", "edit")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$BodyFile,

  [string]$Title,
  [string]$Number,
  [string]$Base = "main",
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BodyFile -PathType Leaf)) {
  throw "PR本文ファイルが見つかりません: $BodyFile"
}

$resolvedBodyFile = (Resolve-Path -LiteralPath $BodyFile).Path
$bodyBytes = [System.IO.File]::ReadAllBytes($resolvedBodyFile)

# GitHubへ渡す本文はUTF-8 BOMなしに限定する。
if ($bodyBytes.Length -ge 3 -and
    $bodyBytes[0] -eq 0xEF -and
    $bodyBytes[1] -eq 0xBB -and
    $bodyBytes[2] -eq 0xBF) {
  throw "PR本文ファイルはUTF-8 BOMなしで保存してください: $resolvedBodyFile"
}

$utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
try {
  $body = $utf8Strict.GetString($bodyBytes)
}
catch {
  throw "PR本文ファイルが有効なUTF-8ではありません: $resolvedBodyFile"
}

# 改行・タブ以外の制御文字は、PowerShell/JSONのエスケープ混入を示す。
if ($body -match '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') {
  throw "PR本文に制御文字が含まれています。実改行を含むUTF-8 Markdownを作成してください。"
}

# コードブロック内のサンプル（例: curlの\n）は許容し、本文構造部分の
# リテラル \n は拒否する。
$inFence = $false
foreach ($line in [regex]::Split($body, "`n")) {
 if ($line -match '^\s*```') {
   $inFence = -not $inFence
   continue
 }
  $lineWithoutCode = [regex]::Replace($line, '`+[^`]*`+', '')
  if (-not $inFence -and $lineWithoutCode.Contains('\n')) {
   throw "PR本文にリテラル \n が含まれています。実改行を使ってください。"
 }
}

if ($ValidateOnly) {
  Write-Output "PR本文ファイルをUTF-8/Markdownとして検証しました: $resolvedBodyFile"
  exit 0
}

$ghArgs = @("pr", $Action)
if ($Action -eq "create") {
  if ([string]::IsNullOrWhiteSpace($Title)) {
    throw "create には -Title が必要です。"
  }
  $ghArgs += @("--base", $Base, "--title", $Title, "--body-file", $resolvedBodyFile)
}
else {
  if ([string]::IsNullOrWhiteSpace($Number)) {
    throw "edit には -Number が必要です。"
  }
  $ghArgs += @($Number, "--body-file", $resolvedBodyFile)
}

& gh @ghArgs
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$target = if ($Action -eq "create") {
  (& gh pr view --json url --jq .url | Out-String).Trim()
}
else {
  $Number
}

$remoteBody = (& gh pr view $target --json body --jq .body | Out-String) -replace "`r`n", "`n" -replace "`r", "`n"
$remoteBody = $remoteBody.TrimEnd("`n")
$expectedBody = ($body -replace "`r`n", "`n" -replace "`r", "`n").TrimEnd("`n")
if ($remoteBody -cne $expectedBody) {
  throw "GitHub上のPR本文が入力ファイルと一致しません: $target"
}

Write-Output "PR本文をUTF-8/Markdownとして検証しました: $target"
