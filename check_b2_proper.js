require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');

async function searchB2(targetId) {
  const B2_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
  const B2_APP_KEY = process.env.B2_APPLICATION_KEY;
  const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

  try {
    const authHeader = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
    const authResp = await axios.get('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      headers: { Authorization: `Basic ${authHeader}` }
    });
    const { apiUrl, authorizationToken } = authResp.data;

    let startFileName = null;
    let matches = [];
    console.log(`Searching B2 for: ${targetId}`);

    do {
      const resp = await axios.post(`${apiUrl}/b2api/v2/b2_list_file_names`, {
        bucketId: B2_BUCKET_ID,
        startFileName: startFileName || undefined,
        maxFileCount: 1000
      }, {
        headers: { Authorization: authorizationToken }
      });

      const files = resp.data.files || [];
      for (const f of files) {
        if (f.fileName.includes(targetId)) {
          matches.push(f.fileName);
        }
      }
      startFileName = resp.data.nextFileName;
    } while (startFileName);

    console.log(`B2 matches for ${targetId}:`, matches);
    return matches;
  } catch (e) {
    console.error(`B2 search error for ${targetId}:`, e.response?.data || e.message);
    return [];
  }
}

const targets = ['8956', '9726', 'EMP2025', 'MP1692830'];

async function main() {
  for (const t of targets) {
    await searchB2(t);
  }
}

main().catch(console.error).finally(() => process.exit(0));
