// Prepare the static build for GitHub Pages: client-only index + 404.html fallback + .nojekyll.
// The app uses hash routing, so prerendered pages are useless here; the prerendered root
// is just a redirect to "/#/" (which would leave the /Deckmon/ base), so always serve the CSR shell.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'dist', 'digimon-card-game-collector', 'browser');
const csr = path.join(dir, 'index.csr.html');
const shell = fs.existsSync(csr) ? csr : path.join(dir, 'index.html');
if (shell !== path.join(dir, 'index.html')) fs.copyFileSync(shell, path.join(dir, 'index.html'));
fs.copyFileSync(shell, path.join(dir, '404.html'));
fs.writeFileSync(path.join(dir, '.nojekyll'), '');
