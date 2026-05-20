# Meta Ads Manager Automation

Playwright와 기존 Chrome CDP 세션을 사용해 Meta Ads Manager 화면을 자동 조작합니다.

현재 프로그램은 두 가지 캠페인 모드를 지원합니다.

- `IMAGE_ONLY`: 기존 이미지 전용 흐름입니다. `CAMPAIGN_MODE`를 비워두거나 `IMAGE_ONLY`로 두면 기존 방식으로 동작합니다.
- `BLOG_MIXED`: 블로그 캠페인용 흐름입니다. 광고세트 1개당 이미지 광고 4개와 동영상 광고 1개를 구성합니다.

## 실행

1. Chrome을 remote debugging 모드로 실행합니다.
2. Meta Ads Manager에 로그인된 상태를 유지합니다.
3. `.env`를 설정합니다.
4. 실행합니다.

```bash
npm run open-campaign
```

## Streamlit MVP

터미널 명령을 직접 입력하지 않고 MVP 웹 UI에서 관리할 수 있습니다.

처음 한 번:

```bash
pip install -r requirements.txt
```

실행:

```bash
python -m streamlit run streamlit_app.py
```

또는 Windows에서:

```bat
run-streamlit.cmd
```

Streamlit MVP에서 할 수 있는 일:

- `git pull origin main`
- `npm install`
- `.env` 저장 및 VS Code로 열기
- 캠페인 유형 선택: `BLOG_MIXED` 또는 `IMAGE_ONLY`
- 캠페인 유형에 따른 입력 항목 활성화
- `BLOG_MIXED` 랜딩 URL을 광고세트 수만큼 입력
- 바탕화면 `F_I_B_O_L_MMDD` 소재 루트 폴더 설정
- dry-run 실행
- Chrome CDP 실행
- 실제 자동화 PowerShell 실행

## 공통 환경 변수

```env
AD_ACCOUNT_ID=
CAMPAIGN_NAME=
CAMPAIGN_MODE=IMAGE_ONLY
DRY_RUN=false

ADSET_START_INDEX=1
ADSET_COUNT=9
AD_CREATIVE_COUNT=4
ADSET_DAILY_BUDGET=100000

CDP_URL=http://127.0.0.1:9222
SCHEDULE_TIME=05:00
MEDIA_FOLDER_PATH=
```

## IMAGE_ONLY 모드

기존 이미지 전용 모드입니다. 기존 `.env`와 호환됩니다.

- 광고세트명은 기존 `MMDD {ADSET_BASE_NAME} {index}번 광고세트` 규칙을 유지합니다.
- 광고명은 기존 `f_i_o_l_MMDD_XX` 규칙을 유지합니다.
- 랜딩 URL도 기존 광고명 기반 URL 생성 방식을 유지합니다.
- 기존 이미지 업로드/검색 흐름을 그대로 사용합니다.

예시:

```env
CAMPAIGN_MODE=IMAGE_ONLY
ADSET_START_INDEX=1
ADSET_COUNT=9
AD_CREATIVE_COUNT=4
ADSET_DAILY_BUDGET=100000
AD_FORMAT=image
```

## BLOG_MIXED 모드

블로그 캠페인 모드입니다. 광고세트 1개 안에 총 5개 광고가 생성됩니다.

- 1~4번 광고: 이미지 광고
- 5번 광고: 동영상 광고
- 광고세트별 랜딩 URL은 반드시 `.env`의 `BLOG_LANDING_URL_N`에서 읽습니다.
- URL은 광고명이나 광고세트명에서 추론하지 않습니다.

필수 예시:

```env
CAMPAIGN_MODE=BLOG_MIXED
DRY_RUN=true

ADSET_COUNT=5
BLOG_IMAGE_ADS_PER_ADSET=4
BLOG_VIDEO_ADS_PER_ADSET=1
BLOG_TOTAL_ADS_PER_ADSET=5

BLOG_ADSET_NAME_PREFIX=f_i_b_o_l
BLOG_IMAGE_AD_NAME_PREFIX=f_i_b_o_l
BLOG_VIDEO_AD_NAME_PREFIX=f_v_b_o_l

DATE_FORMAT=MMDD

BLOG_LANDING_URL_1=https://example.com/landing-1
BLOG_LANDING_URL_2=https://example.com/landing-2
BLOG_LANDING_URL_3=https://example.com/landing-3
BLOG_LANDING_URL_4=https://example.com/landing-4
BLOG_LANDING_URL_5=https://example.com/landing-5

BLOG_ASSET_ROOT=./assets/blog
```

## BLOG_MIXED 이름 규칙

날짜는 오늘 날짜를 `MMDD`로 계산합니다. 예: 5월 20일은 `0520`.

광고세트명:

```text
f_i_b_o_l_{MMDD}_{adset_index}
```

광고명:

```text
이미지 광고 1: f_i_b_o_l_{MMDD}_1
이미지 광고 2: f_i_b_o_l_{MMDD}_2
이미지 광고 3: f_i_b_o_l_{MMDD}_3
이미지 광고 4: f_i_b_o_l_{MMDD}_4
동영상 광고 5: f_v_b_o_l_{MMDD}_5
```

위 광고명 규칙은 광고세트마다 반복됩니다.

## 랜딩 URL 매핑

`BLOG_MIXED` 모드에서는 광고세트 인덱스와 랜딩 URL 인덱스가 1:1입니다.

```text
광고세트 1 -> BLOG_LANDING_URL_1
광고세트 2 -> BLOG_LANDING_URL_2
광고세트 3 -> BLOG_LANDING_URL_3
```

`ADSET_COUNT=5`이면 `BLOG_LANDING_URL_1`부터 `BLOG_LANDING_URL_5`까지 모두 있어야 합니다.

## 소재 입력 방식

기존 프로그램은 폴더 기반 이미지 업로드 흐름을 사용합니다. 그래서 `BLOG_MIXED`도 폴더 기반 매핑을 우선 지원합니다.

기본 폴더 구조:

```text
assets/blog/
  adset_1/
    images/
      image1.jpg
      image2.jpg
      image3.jpg
      image4.jpg
    videos/
      video1.mp4
  adset_2/
    images/
    videos/
```

환경 변수:

```env
BLOG_ASSET_ROOT=./assets/blog
```

광고세트별로 직접 지정할 수도 있습니다.

```env
BLOG_ADSET_1_IMAGE_DIR=./assets/blog/adset_1/images
BLOG_ADSET_1_VIDEO_DIR=./assets/blog/adset_1/videos

BLOG_ADSET_2_IMAGE_DIR=./assets/blog/adset_2/images
BLOG_ADSET_2_VIDEO_DIR=./assets/blog/adset_2/videos
```

명시적 파일 목록도 지원합니다.

```env
BLOG_ADSET_1_IMAGE_ASSETS=./assets/blog/adset_1/images/image1.jpg,./assets/blog/adset_1/images/image2.jpg,./assets/blog/adset_1/images/image3.jpg,./assets/blog/adset_1/images/image4.jpg
BLOG_ADSET_1_VIDEO_ASSET=./assets/blog/adset_1/videos/video1.mp4
```

이미지 확장자:

```text
png, jpg, jpeg, webp, gif
```

동영상 확장자:

```text
mp4, mov, m4v, webm
```

## Dry Run

실제 Meta 화면 조작 없이 계획만 검수하려면:

```env
DRY_RUN=true
```

출력 내용:

- campaign mode
- campaign name
- 생성될 광고세트명
- 광고세트별 landing URL
- 이미지 광고 4개 이름과 소재
- 동영상 광고 1개 이름과 소재
- creative type

## 자주 나는 에러

`Missing BLOG_LANDING_URL_3. BLOG_MIXED mode requires one landing URL per adset.`

`ADSET_COUNT`가 3 이상인데 `BLOG_LANDING_URL_3`이 없습니다. `.env`에 추가하세요.

`BLOG_MIXED requires exactly 4 image assets for adset 1. Found 3.`

광고세트 1 이미지 폴더에 이미지가 4개가 아닙니다. 정확히 4개를 넣으세요.

`BLOG_MIXED requires exactly 1 video asset for adset 1.`

광고세트 1 동영상 폴더에 지원되는 동영상 파일이 없습니다.

`Invalid video asset ... Allowed: mp4, mov, m4v, webm.`

동영상 확장자가 지원 목록에 없습니다.

## 테스트

```bash
npm test
```
