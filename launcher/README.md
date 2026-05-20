# Meta Ads Launcher

`MetaAdsLauncher.exe`를 더블클릭하면 작은 실행 창이 열립니다.

- `실행`: `npm run open-campaign`을 새 PowerShell 창에서 실행합니다.
- `.env 열기`: 현재 PC의 `.env` 설정 파일을 메모장으로 엽니다.
- `폴더 열기`: 자동화 작업 폴더를 엽니다.

EXE를 다시 만들 때는 아래 명령을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File launcher\build-launcher.ps1
```
