import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildGalaxyCatalogDocument, GALAXY_CATALOG_PATH } from './galaxy-catalog.js';

const document = buildGalaxyCatalogDocument();
await writeFile(resolve(GALAXY_CATALOG_PATH), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`WROTE: ${GALAXY_CATALOG_PATH} (${document.systems.length} systems, ${document.fingerprintSha256})`);
