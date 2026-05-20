import 'dotenv/config';

console.log('[LOGIN] 이 프로젝트는 로그인 자동화를 수행하지 않습니다.');
console.log('[LOGIN] 일반 Chrome을 아래처럼 직접 실행하고 로그인 상태를 준비하세요:');
console.log('  chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug"');
console.log('[LOGIN] 이후 npm run open-campaign 을 실행하면 기존 Chrome 세션에 attach해서 자동화를 진행합니다.');
