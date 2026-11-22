# Extract the signing certificate from an APK Signing Block (v2/v3) and print
# its SHA-256 fingerprint -- the value Android compares against assetlinks.json.
param([Parameter(Mandatory=$true)][string]$ApkPath)

$bytes = [System.IO.File]::ReadAllBytes($ApkPath)
$magic = [System.Text.Encoding]::ASCII.GetBytes("APK Sig Block 42")

# Scan backwards for the magic that terminates the signing block.
$magicPos = -1
for ($i = $bytes.Length - $magic.Length; $i -ge 0; $i--) {
    $match = $true
    for ($j = 0; $j -lt $magic.Length; $j++) {
        if ($bytes[$i + $j] -ne $magic[$j]) { $match = $false; break }
    }
    if ($match) { $magicPos = $i; break }
}
if ($magicPos -lt 0) { throw "APK Signing Block magic not found" }

$blockSize = [BitConverter]::ToUInt64($bytes, $magicPos - 8)
$firstSizeField = $magicPos + 8 - [int64]$blockSize
$pos = $firstSizeField + 8
$pairsEnd = $magicPos - 8

$v2Id = 0x7109871a
$v3Id = 0xf05368c0
$value = $null
$foundId = $null

while ($pos -lt $pairsEnd) {
    $pairLen = [BitConverter]::ToUInt64($bytes, $pos)
    $id = [BitConverter]::ToUInt32($bytes, $pos + 8)
    if ($id -eq $v2Id -or $id -eq $v3Id) {
        $valStart = $pos + 12
        $valLen = [int64]$pairLen - 4
        $value = New-Object byte[] $valLen
        [Array]::Copy($bytes, $valStart, $value, 0, $valLen)
        $foundId = $id
        if ($id -eq $v2Id) { break }   # prefer v2; v3 has the same cert
    }
    $pos += 8 + [int64]$pairLen
}
if (-not $value) { throw "No v2/v3 signature scheme block found" }

# value: seq(signers) -> signer -> signed data -> digests, certificates
function Read-U32([byte[]]$b, [int64]$o) { return [int64][BitConverter]::ToUInt32($b, $o) }

$o = 0
$o += 4                                   # length of signers sequence
$o += 4                                   # length of first signer
$signedDataLen = Read-U32 $value $o; $o += 4
$digestsLen = Read-U32 $value $o; $o += 4
$o += $digestsLen                         # skip digests
$certsLen = Read-U32 $value $o; $o += 4
$certLen = Read-U32 $value $o; $o += 4

$der = New-Object byte[] $certLen
[Array]::Copy($value, $o, $der, 0, $certLen)

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$der)
"scheme   : " + $(if ($foundId -eq $v2Id) { "v2" } else { "v3" })
"subject  : " + $cert.Subject
"issuer   : " + $cert.Issuer
"validity : " + $cert.NotBefore.ToString("yyyy-MM-dd") + " .. " + $cert.NotAfter.ToString("yyyy-MM-dd")
"SHA256   : " + ($cert.GetCertHashString("SHA256") -replace '(..)(?!$)', '$1:')
"SHA1     : " + ($cert.GetCertHashString("SHA1") -replace '(..)(?!$)', '$1:')
