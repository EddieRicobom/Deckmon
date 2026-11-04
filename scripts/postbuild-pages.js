// Prepare the static build for GitHub Pages: 404.html fallback + .nojekyll
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'dist', 'digimon-card-game-collector', 'browser');
const idx = fs.existsSync(path.join(dir, 'index.csr.html')) ? 'index.csr.html' : 'index.html';
fs.copyFileSync(path.join(dir, idx), path.join(dir, '404.html'));
if (idx !== 'index.html' && !fs.existsSync(path.join(dir, 'index.html'))) fs.copyFileSync(path.join(dir, idx), path.join(dir, 'index.html'));
fs.writeFileSync(path.join(dir, '.nojekyll'), '');
