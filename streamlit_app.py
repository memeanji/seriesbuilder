from __future__ import annotations

import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

import streamlit as st


APP_DIR = Path(__file__).resolve().parent
ENV_PATH = APP_DIR / ".env"
ADS_MANAGER_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns"
DEFAULT_ACCOUNT_ID = "1838892106940197"


def read_env(path: Path = ENV_PATH) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_env(values: dict[str, str], path: Path = ENV_PATH) -> None:
    mode = values.get("CAMPAIGN_MODE", "IMAGE_ONLY")
    lines = [
        f"AD_ACCOUNT_ID={values.get('AD_ACCOUNT_ID', '')}",
        f"CAMPAIGN_NAME={values.get('CAMPAIGN_NAME', '')}",
        "",
        f"CAMPAIGN_MODE={mode}",
        f"DRY_RUN={values.get('DRY_RUN', 'true')}",
        "",
        f"ADSET_START_INDEX={values.get('ADSET_START_INDEX', '1')}",
        f"ADSET_COUNT={values.get('ADSET_COUNT', '1')}",
        f"ADSET_DAILY_BUDGET={values.get('ADSET_DAILY_BUDGET', '100000')}",
        f"CDP_URL={values.get('CDP_URL', 'http://127.0.0.1:9222')}",
        f"SCHEDULE_TIME={values.get('SCHEDULE_TIME', '05:00')}",
        "",
    ]

    if mode == "BLOG_MIXED":
        lines.extend(
            [
                "BLOG_IMAGE_ADS_PER_ADSET=4",
                "BLOG_VIDEO_ADS_PER_ADSET=1",
                "BLOG_TOTAL_ADS_PER_ADSET=5",
                "BLOG_ADSET_NAME_PREFIX=f_i_b_o_l",
                "BLOG_IMAGE_AD_NAME_PREFIX=f_i_b_o_l",
                "BLOG_VIDEO_AD_NAME_PREFIX=f_v_b_o_l",
                "DATE_FORMAT=YYYYMMDD",
                "",
                f"BLOG_ASSET_ROOT={values.get('BLOG_ASSET_ROOT', '')}",
                "",
            ]
        )
        adset_count = int(values.get("ADSET_COUNT", "1") or "1")
        for index in range(1, adset_count + 1):
            lines.append(f"BLOG_LANDING_URL_{index}={values.get(f'BLOG_LANDING_URL_{index}', '')}")
        lines.append("")
    else:
        lines.extend(
            [
                f"AD_CREATIVE_COUNT={values.get('AD_CREATIVE_COUNT', '4')}",
                "AD_FORMAT=image",
                f"MEDIA_FOLDER_PATH={values.get('MEDIA_FOLDER_PATH', '')}",
                "",
            ]
        )

    lines.extend(
        [
            "QUICK_TEST_CREATIVE_STEP=false",
            f"QUICK_TEST_AD_NAME={values.get('QUICK_TEST_AD_NAME', 'f_i_o_l_0518_1')}",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def run_command(command: list[str], timeout: int = 300) -> tuple[int, str]:
    completed = subprocess.run(
        command,
        cwd=APP_DIR,
        text=True,
        capture_output=True,
        timeout=timeout,
        shell=False,
    )
    output = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
    return completed.returncode, output


def start_powershell(command: str) -> None:
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        cwd=APP_DIR,
        creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0,
    )


def default_blog_root() -> str:
    mmdd = datetime.now().strftime("%m%d")
    return str(Path.home() / "Desktop" / f"F_I_B_O_L_{mmdd}")


def schedule_label(schedule_time: str) -> str:
    hour = schedule_time.split(":", 1)[0].zfill(2)
    return f"{hour}시"


def expected_blog_folder_name(adset_index: int, budget: str, schedule_time: str) -> str:
    mmdd = datetime.now().strftime("%m%d")
    budget_manwon = int(int(budget or "0") / 10000)
    return f"{mmdd} {adset_index}번 광고세트-일예산 {budget_manwon}만원-이미지 4개 + 영상 1개-익일 {schedule_label(schedule_time)}"


def show_command_result(title: str, code: int, output: str) -> None:
    if code == 0:
        st.success(f"{title} 완료")
    else:
        st.error(f"{title} 실패: exit code {code}")
    st.code(output or "(no output)", language="text")


st.set_page_config(page_title="Meta Ads Automation", layout="wide")
st.title("Meta Ads Automation MVP")

env = read_env()

with st.sidebar:
    st.subheader("작업")
    if st.button("최근 코드 받아오기"):
        code, output = run_command(["git", "pull", "origin", "main"])
        show_command_result("git pull", code, output)

    if st.button("패키지 동기화"):
        code, output = run_command(["npm.cmd", "install"], timeout=600)
        show_command_result("npm install", code, output)

    if st.button(".env VS Code로 열기"):
        subprocess.Popen(["code.cmd", str(ENV_PATH)], cwd=APP_DIR, shell=False)
        st.info(".env를 VS Code로 열었습니다.")

    if st.button("Chrome CDP 열기"):
        account_id = env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)
        url = f"{ADS_MANAGER_URL}?act={account_id}"
        chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        command = f'& "{chrome}" --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug" "{url}"'
        start_powershell(command)
        st.info("Chrome CDP 창을 열었습니다.")

    if st.button("자동화 실행 터미널 열기"):
        start_powershell("npm run open-campaign")
        st.info("별도 PowerShell에서 자동화를 실행했습니다.")


st.subheader("캠페인 설정")

left, right = st.columns(2)
with left:
    campaign_mode = st.selectbox(
        "캠페인 유형",
        ["BLOG_MIXED", "IMAGE_ONLY"],
        index=0 if env.get("CAMPAIGN_MODE", "IMAGE_ONLY") == "BLOG_MIXED" else 1,
    )
    dry_run = st.toggle("DRY_RUN", value=env.get("DRY_RUN", "true").lower() == "true")
    ad_account_id = st.text_input("광고 계정 ID", value=env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
    campaign_name = st.text_input("캠페인명", value=env.get("CAMPAIGN_NAME", ""))

with right:
    adset_count = st.number_input("광고세트 수", min_value=1, max_value=100, value=int(env.get("ADSET_COUNT", "3") or "3"))
    daily_budget = st.text_input("일예산", value=env.get("ADSET_DAILY_BUDGET", "300000"))
    schedule_time = st.text_input("예약 시간", value=env.get("SCHEDULE_TIME", "05:00"))
    cdp_url = st.text_input("CDP URL", value=env.get("CDP_URL", "http://127.0.0.1:9222"))

next_env: dict[str, str] = {
    "AD_ACCOUNT_ID": ad_account_id,
    "CAMPAIGN_NAME": campaign_name,
    "CAMPAIGN_MODE": campaign_mode,
    "DRY_RUN": str(dry_run).lower(),
    "ADSET_START_INDEX": "1",
    "ADSET_COUNT": str(adset_count),
    "ADSET_DAILY_BUDGET": daily_budget,
    "CDP_URL": cdp_url,
    "SCHEDULE_TIME": schedule_time,
}

if campaign_mode == "BLOG_MIXED":
    st.subheader("BLOG_MIXED 설정")
    st.caption("이미지 4개 + 동영상 1개는 고정값으로 저장됩니다.")
    blog_root = st.text_input("블로그 소재 루트 폴더", value=env.get("BLOG_ASSET_ROOT", default_blog_root()))
    next_env["BLOG_ASSET_ROOT"] = blog_root

    with st.expander("예상 폴더명 확인", expanded=True):
        for index in range(1, int(adset_count) + 1):
            st.write(f"{index}. `{expected_blog_folder_name(index, daily_budget, schedule_time)}`")

    st.subheader("광고세트별 랜딩 URL")
    for index in range(1, int(adset_count) + 1):
        key = f"BLOG_LANDING_URL_{index}"
        next_env[key] = st.text_input(f"광고세트 {index} 랜딩 URL", value=env.get(key, ""))
else:
    st.subheader("IMAGE_ONLY 설정")
    creative_count = st.number_input("이미지 광고 수", min_value=1, max_value=100, value=int(env.get("AD_CREATIVE_COUNT", "4") or "4"))
    media_folder = st.text_input("이미지 소재 폴더", value=env.get("MEDIA_FOLDER_PATH", ""))
    next_env["AD_CREATIVE_COUNT"] = str(creative_count)
    next_env["MEDIA_FOLDER_PATH"] = media_folder

st.divider()

col1, col2, col3 = st.columns(3)
with col1:
    if st.button(".env 저장", type="primary"):
        write_env(next_env)
        st.success(f"저장 완료: {ENV_PATH}")

with col2:
    if st.button("Dry-run 실행"):
        write_env({**next_env, "DRY_RUN": "true"})
        code, output = run_command(["npm.cmd", "run", "open-campaign"], timeout=300)
        show_command_result("dry-run", code, output)

with col3:
    if st.button("실제 실행 터미널 열기"):
        write_env({**next_env, "DRY_RUN": "false"})
        start_powershell("npm run open-campaign")
        st.warning("DRY_RUN=false로 저장하고 별도 PowerShell에서 실행했습니다.")

with st.expander("현재 .env 미리보기", expanded=False):
    if ENV_PATH.exists():
        st.code(ENV_PATH.read_text(encoding="utf-8"), language="dotenv")
    else:
        st.info(".env 파일이 아직 없습니다.")
