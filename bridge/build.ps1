# Compiles the screen bridge with the C# compiler that ships with Windows.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$out = Join-Path $PSScriptRoot 'LianLiLcdBridge.exe'
& $csc /nologo /optimize+ /target:winexe "/out:$out" (Join-Path $PSScriptRoot 'LianLiLcdBridge.cs')
if ($LASTEXITCODE -ne 0) {
    throw 'Bridge did not compile.'
}
"Built $out"
