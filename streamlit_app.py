from __future__ import annotations

import os
import subprocess
from datetime import datetime
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


def write_env(values: dict[str, str], path: Path = ENV_PATH) -> str:
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
                "DATE_FORMAT=MMDD",
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
                f"IMAGE_ONLY_UPLOAD_MODE={values.get('IMAGE_ONLY_UPLOAD_MODE', '')}",
                f"IMAGE_ONLY_ASSET_ROOT={values.get('IMAGE_ONLY_ASSET_ROOT', '')}",
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
    content = "\n".join(lines)
    path.write_text(content, encoding="utf-8")
    return content


def run_command(command: list[str], timeout: int = 300) -> tuple[int, str]:
    completed = subprocess.run(
        command,
        cwd=APP_DIR,
        text=True,
        capture_output=True,
        timeout=timeout,
        shell=False,
        encoding="utf-8",
        errors="replace",
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


def expected_blog_folder_name(adset_index: int, budget: str, schedule_time: str) -> str:
    mmdd = datetime.now().strftime("%m%d")
    budget_manwon = int(int(budget or "0") / 10000)
    hour = schedule_time.split(":", 1)[0].zfill(2)
    return f"{mmdd} {adset_index}번 광고세트-일예산 {budget_manwon}만원-이미지 4개 + 영상 1개-익일 {hour}시"


def validate_form(values: dict[str, str]) -> list[str]:
    errors: list[str] = []
    if not values.get("CAMPAIGN_NAME", "").strip():
        errors.append("CAMPAIGN_NAME is required.")
    if not values.get("AD_ACCOUNT_ID", "").strip():
        errors.append("AD_ACCOUNT_ID is required.")
    if values.get("CAMPAIGN_MODE") == "BLOG_MIXED":
        if not values.get("BLOG_ASSET_ROOT", "").strip():
            errors.append("BLOG_ASSET_ROOT is required for BLOG_MIXED.")
        adset_count = int(values.get("ADSET_COUNT", "1") or "1")
        for index in range(1, adset_count + 1):
            if not values.get(f"BLOG_LANDING_URL_{index}", "").strip():
                errors.append(f"BLOG_LANDING_URL_{index} is required.")
    elif values.get("IMAGE_ONLY_UPLOAD_MODE") == "PER_AD":
        if not (values.get("IMAGE_ONLY_ASSET_ROOT", "").strip() or values.get("MEDIA_FOLDER_PATH", "").strip()):
            errors.append("IMAGE_ONLY PER_AD requires IMAGE_ONLY_ASSET_ROOT or MEDIA_FOLDER_PATH.")
    return errors


def show_command_result(title: str, command: list[str], code: int, output: str) -> None:
    if code == 0:
        st.success(f"{title} completed")
    else:
        st.error(f"{title} failed: exit code {code}")
    st.caption("Command")
    st.code(" ".join(command), language="text")
    st.caption("Output")
    st.code(output if output.strip() else "(empty output)", language="text")


st.set_page_config(page_title="Meta Ads Automation", layout="wide")
st.title("Meta Ads Automation MVP")

env = read_env()

with st.sidebar:
    st.subheader("Actions")
    if st.button("Pull latest code"):
        command = ["git", "pull", "origin", "main"]
        code, output = run_command(command)
        show_command_result("git pull", command, code, output)

    if st.button("Install npm packages"):
        command = ["npm.cmd", "install"]
        code, output = run_command(command, timeout=600)
        show_command_result("npm install", command, code, output)

    if st.button("Open .env in VS Code"):
        subprocess.Popen(["code.cmd", str(ENV_PATH)], cwd=APP_DIR, shell=False)
        st.info(".env open requested.")

    if st.button("Open Chrome CDP"):
        account_id = env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)
        url = f"{ADS_MANAGER_URL}?act={account_id}"
        chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        command = f'& "{chrome}" --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug" "{url}"'
        start_powershell(command)
        st.info("Chrome CDP PowerShell opened.")

    if st.button("Open automation terminal"):
        start_powershell("npm run open-campaign")
        st.info("Automation PowerShell opened.")


st.subheader("Campaign Settings")

left, right = st.columns(2)
with left:
    campaign_mode = st.selectbox(
        "Campaign mode",
        ["BLOG_MIXED", "IMAGE_ONLY"],
        index=0 if env.get("CAMPAIGN_MODE", "IMAGE_ONLY") == "BLOG_MIXED" else 1,
    )
    dry_run = st.toggle("DRY_RUN", value=env.get("DRY_RUN", "true").lower() == "true")
    ad_account_id = st.text_input("Ad account ID", value=env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
    campaign_name = st.text_input("Campaign name", value=env.get("CAMPAIGN_NAME", ""))

with right:
    adset_count = st.number_input("Adset count", min_value=1, max_value=100, value=int(env.get("ADSET_COUNT", "3") or "3"))
    daily_budget = st.text_input("Daily budget", value=env.get("ADSET_DAILY_BUDGET", "300000"))
    schedule_time = st.text_input("Schedule time", value=env.get("SCHEDULE_TIME", "05:00"))
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
    st.subheader("BLOG_MIXED")
    st.caption("Fixed structure: 4 image ads + 1 video ad per adset.")
    blog_root = st.text_input("Blog asset root", value=env.get("BLOG_ASSET_ROOT", default_blog_root()))
    next_env["BLOG_ASSET_ROOT"] = blog_root

    with st.expander("Expected folder names", expanded=True):
        for index in range(1, int(adset_count) + 1):
            st.write(f"{index}. `{expected_blog_folder_name(index, daily_budget, schedule_time)}`")

    st.subheader("Landing URLs")
    for index in range(1, int(adset_count) + 1):
        key = f"BLOG_LANDING_URL_{index}"
        next_env[key] = st.text_input(f"Adset {index} landing URL", value=env.get(key, ""))
else:
    st.subheader("IMAGE_ONLY")
    creative_count = st.number_input("Image ad count", min_value=1, max_value=100, value=int(env.get("AD_CREATIVE_COUNT", "4") or "4"))
    per_ad_upload = st.checkbox(
        "Upload one image per ad",
        value=env.get("IMAGE_ONLY_UPLOAD_MODE", "").upper() == "PER_AD",
    )
    media_folder = st.text_input("Image media folder", value=env.get("IMAGE_ONLY_ASSET_ROOT") or env.get("MEDIA_FOLDER_PATH", ""))
    next_env["AD_CREATIVE_COUNT"] = str(creative_count)
    next_env["IMAGE_ONLY_UPLOAD_MODE"] = "PER_AD" if per_ad_upload else ""
    next_env["IMAGE_ONLY_ASSET_ROOT"] = media_folder if per_ad_upload else ""
    next_env["MEDIA_FOLDER_PATH"] = media_folder

st.divider()

col1, col2, col3 = st.columns(3)
with col1:
    if st.button("Save .env", type="primary"):
        saved = write_env(next_env)
        st.success(f"Saved: {ENV_PATH}")
        st.code(saved, language="dotenv")

with col2:
    if st.button("Run dry-run"):
        dry_run_env = {**next_env, "DRY_RUN": "true"}
        errors = validate_form(dry_run_env)
        saved = write_env(dry_run_env)
        st.caption("Saved .env for dry-run")
        st.code(saved, language="dotenv")
        if errors:
            st.error("Fix these fields before dry-run:")
            for error in errors:
                st.write(f"- {error}")
        else:
            command = ["node", "src/open-campaign.js"]
            code, output = run_command(command, timeout=300)
            show_command_result("dry-run", command, code, output)

with col3:
    if st.button("Run real automation terminal"):
        real_env = {**next_env, "DRY_RUN": "false"}
        errors = validate_form(real_env)
        saved = write_env(real_env)
        st.caption("Saved .env for real run")
        st.code(saved, language="dotenv")
        if errors:
            st.error("Fix these fields before real run:")
            for error in errors:
                st.write(f"- {error}")
        else:
            start_powershell("npm run open-campaign")
            st.warning("DRY_RUN=false saved. Automation terminal opened.")

with st.expander("Current .env", expanded=False):
    if ENV_PATH.exists():
        st.code(ENV_PATH.read_text(encoding="utf-8"), language="dotenv")
    else:
        st.info(".env does not exist yet.")
