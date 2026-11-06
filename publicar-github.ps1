# Uso (dentro da pasta do projeto, onde fica o package.json):
#   powershell -ExecutionPolicy Bypass -File .\publicar-github.ps1

$ErrorActionPreference = "Stop"

$GhUser = "Dcsc2011"
$GhRepo = "Supernova-Baileys"
$Branch = "main"
$RemoteUrl = "https://github.com/$GhUser/$GhRepo.git"

function Check($msg) {
    if ($LASTEXITCODE -ne 0) { throw "Falhou: $msg" }
}

if (-not (Test-Path package.json)) { throw "Rode este script dentro da pasta do projeto (package.json nao encontrado)." }
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw "git nao esta instalado." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node nao esta instalado." }

Write-Host "-> Adicionando repository e bugs ao package.json (homepage/Instagram fica intacto)..."
$js = @'
const fs = require("fs");
const { GH_USER, GH_REPO } = process.env;
const base = `https://github.com/${GH_USER}/${GH_REPO}`;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.repository = { type: "git", url: `git+${base}.git` };
pkg.bugs = { url: `${base}/issues` };
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
'@
$tmp = Join-Path $env:TEMP "patch-pkg.js"
Set-Content -Path $tmp -Value $js -Encoding UTF8
$env:GH_USER = $GhUser
$env:GH_REPO = $GhRepo
node $tmp
Check "atualizar package.json"
Remove-Item $tmp -Force

Write-Host "-> Criando .gitignore..."
if (-not (Test-Path .gitignore)) {
    Set-Content -Path .gitignore -Value "node_modules`n*.tgz`n.env`nauth_info*" -Encoding ASCII
}

Write-Host "-> Preparando repositorio git..."
if (-not (Test-Path .git)) { git init -b $Branch; Check "git init" }

git add .
Check "git add"

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    $version = node -p "require('./package.json').version"
    git commit -m "feat: release $version"
    Check "git commit (configure: git config --global user.name / user.email)"
} else {
    Write-Host "   Nada novo para commitar."
}

git remote get-url origin 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { git remote set-url origin $RemoteUrl } else { git remote add origin $RemoteUrl }
Check "configurar remote"

$tag = "v" + (node -p "require('./package.json').version")
git tag -f $tag
Check "criar tag"

Write-Host "-> Enviando para $RemoteUrl ..."
Write-Host "   (se pedir senha, use um Personal Access Token do GitHub, nao a senha da conta)"
git push -u origin $Branch
Check "git push"
git push -f origin $tag
Check "git push da tag"

Write-Host ""
Write-Host "Pronto! Repositorio: https://github.com/$GhUser/$GhRepo"
Write-Host "Proximo passo (npm): npm login ; npm publish --access public"
