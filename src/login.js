import 'dotenv/config';

const profileDir = process.env.CHROME_PROFILE_DIR || 'C:\\meta_profiles\\profile_01';

console.log('[LOGIN] This project does not run an automatic login flow.');
console.log('[LOGIN] Open Chrome with CDP and sign in to Meta Ads Manager first:');
console.log(`  chrome.exe --remote-debugging-port=9222 --user-data-dir="${profileDir}"`);
console.log('[LOGIN] Then run `npm run open-campaign` to attach to that Chrome session.');
