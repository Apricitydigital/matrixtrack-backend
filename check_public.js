const axios = require('axios');
const keys = [
  'faces/8956/1768998115456_8956-face-store-1768998115067.jpg',
  'faces/9726/1774512229039_9726-face-store-1774512228737.jpg'
];
const urls = keys.map(k => `https://attend-ease-images.s3.ap-south-1.amazonaws.com/${k}`);

async function testPublic() {
  for (const url of urls) {
    try {
      const resp = await axios.head(url);
      console.log(`FOUND PUBLIC: ${url} (status: ${resp.status})`);
    } catch (e) {
      console.log(`MISSING PUBLIC: ${url} (${e.response?.status || e.message})`);
    }
  }
}
testPublic().catch(console.error).finally(() => process.exit(0));
