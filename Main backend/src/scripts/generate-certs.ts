import selfsigned from 'selfsigned';
import fs from 'fs';
import path from 'path';
import { Config } from '../config';

/** Generate self-signed HTTPS certificates for the backend */
function generateCerts() {
  Config.init();

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const opts = {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: '*.ol.epicgames.com' },
        { type: 2, value: '*.epicgames.com' },
        { type: 7, ip: '127.0.0.1' },
      ]},
    ],
  };

  const pems = selfsigned.generate(attrs, opts);

  fs.writeFileSync(path.join(Config.CERTS_DIR, 'server.key'), pems.private);
  fs.writeFileSync(path.join(Config.CERTS_DIR, 'server.cert'), pems.cert);

  console.log(`[Certs] Generated self-signed certificates in ${Config.CERTS_DIR}`);
  console.log('[Certs] Subject Alt Names: localhost, *.ol.epicgames.com, *.epicgames.com, 127.0.0.1');
}

generateCerts();
