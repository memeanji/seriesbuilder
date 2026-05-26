from __future__ import annotations

import os
import re
import subprocess
import json
from datetime import datetime
from pathlib import Path

import streamlit as st


APP_DIR = Path(__file__).resolve().parent
ENV_PATH = APP_DIR / ".env"
RUN_ENV_DIR = APP_DIR / ".run-env"
ADS_MANAGER_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns"
DEFAULT_ACCOUNT_ID = "1838892106940197"
DEFAULT_CHROME_PROFILE_DIR = r"C:\meta_profiles\profile_01"
PROFILE_ROOT = r"C:\meta_profiles"
CHROME_PROFILE_SLOTS = {
    "profile_01": {"dir": rf"{PROFILE_ROOT}\profile_01", "cdp_url": "http://127.0.0.1:9222"},
    "profile_02": {"dir": rf"{PROFILE_ROOT}\profile_02", "cdp_url": "http://127.0.0.1:9223"},
    "profile_03": {"dir": rf"{PROFILE_ROOT}\profile_03", "cdp_url": "http://127.0.0.1:9224"},
}
IS_WINDOWS = os.name == "nt"
IS_STREAMLIT_CLOUD = bool(os.environ.get("STREAMLIT_RUNTIME") or os.environ.get("STREAMLIT_SHARING_MODE"))
NOTIFICATION_DEFAULTS = {
    "ENABLE_DESKTOP_ALERT": "true",
    "NOTIFY_ON_SUCCESS": "true",
    "NOTIFY_ON_ERROR": "true",
    "NOTIFY_ON_STOP": "true",
    "NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT": "true",
    "NOTIFICATION_APP_NAME": "Meta Ads Automation",
    "NOTIFICATION_SUCCESS_TITLE": "작업 완료",
    "NOTIFICATION_ERROR_TITLE": "작업 중단",
    "NOTIFICATION_TIMEOUT_TITLE": "업로드 지연",
}


def env_bool(values: dict[str, str], key: str, default: str = "false") -> bool:
    return values.get(key, default).strip().lower() in {"1", "true", "yes", "y", "on"}


def ms_caption(value: int | float) -> str:
    seconds = float(value) / 1000
    if seconds.is_integer():
        return f"{int(seconds)}초"
    return f"{seconds:.1f}초"


def actual_creatives_per_adset(values: dict[str, str]) -> int:
    try:
        return max(1, int(values.get("AD_CREATIVE_COUNT", "4") or "4") + 1)
    except ValueError:
        return 5


def date_tokens(date: datetime | None = None) -> dict[str, str]:
    now = date or datetime.now()
    return {"MMDD": now.strftime("%m%d"), "YYMMDD": now.strftime("%y%m%d")}


def render_template(template: str, variables: dict[str, object]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in variables:
            raise ValueError(f"Unknown template variable: {{{key}}}")
        return str(variables[key])

    return re.sub(r"\{(\w+)\}", replace, template or "")


def ad_media_type(media_type: str, ad_idx: int, ad_count: int) -> str:
    if media_type == "mixed":
        return "video" if ad_idx == ad_count else "image"
    return media_type


def build_ad_url(url_mode: str, shared_url: str, path_numbers: list[int], ad_idx: int, ad_name: str, base_url: str) -> str:
    if url_mode == "shared_manual":
        return shared_url
    path_num = path_numbers[ad_idx - 1]
    return f"{base_url.rstrip('/')}/{path_num}?utm_source=f&utm_medium=f&utm_campaign={ad_name}"


def default_ad_name_for_media(media_type: str, global_index: int, mmdd: str) -> str:
    if media_type == "video":
        return f"f_v_b_o_l_{mmdd}_{global_index}"
    return f"f_i_b_o_l_{mmdd}_{global_index}"


def split_path_numbers(value: str, ad_count: int, default_path: int) -> list[int]:
    raw_items = [item.strip() for item in re.split(r"[,\s]+", value or "") if item.strip()]
    numbers: list[int] = []
    for item in raw_items:
        if item.isdigit():
            numbers.append(int(item))
    if not numbers:
        numbers = [default_path for _ in range(ad_count)]
    if len(numbers) < ad_count:
        numbers.extend([numbers[-1] for _ in range(ad_count - len(numbers))])
    return numbers[:ad_count]


def derive_legacy_mode(create_new: bool, structure: str, media_types: list[str], url_modes: list[str]) -> tuple[str, list[str]]:
    warnings: list[str] = []
    unique_media = set(media_types)
    unique_url = set(url_modes)
    if create_new and structure == "ABO":
        warnings.append("신규 ABO 캠페인 생성은 현재 UI 모델만 준비되어 있고, 기존 Playwright 엔진은 기존 캠페인 append 흐름으로 실행됩니다.")
    if create_new and structure == "CBO":
        if unique_media == {"image"}:
            return "IMAGE_ONLY_CBO", warnings
        if unique_media == {"video"}:
            return "VIDEO_ONLY_CBO", warnings
        warnings.append("현재 기존 자동화 엔진은 CBO mixed 조합을 직접 지원하지 않아 BLOG_MIXED로 변환할 수 없습니다.")
        return "BLOG_MIXED", warnings
    if unique_media == {"mixed"}:
        if "per_ad_auto" in unique_url:
            warnings.append("mixed + 광고별 자동 URL은 기존 엔진에서 세트 공유 URL로만 처리됩니다. 블로그/수동 URL을 권장합니다.")
        return "BLOG_MIXED", warnings
    if unique_media == {"video"}:
        return ("BLOG_VIDEO_DIRECT" if unique_url == {"per_ad_auto"} else "BLOG_VIDEO"), warnings
    if unique_media == {"image"}:
        if "shared_manual" in unique_url:
            warnings.append("이미지 전용 + 세트 공유 URL은 기존 IMAGE_ONLY 엔진에서 아직 직접 지원하지 않습니다. 광고별 자동 URL을 권장합니다.")
        return "IMAGE_ONLY", warnings
    warnings.append("광고세트별 서로 다른 소재 타입은 기존 엔진에서 한 번에 실행할 수 없습니다. 동일 타입끼리 나눠 실행해 주세요.")
    return "BLOG_MIXED", warnings


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
        f"CHROME_PROFILE_DIR={values.get('CHROME_PROFILE_DIR', DEFAULT_CHROME_PROFILE_DIR)}",
        f"RESUME_FROM_AD_INDEX={values.get('RESUME_FROM_AD_INDEX', '1')}",
        f"RESUME_FROM_AD_NAME={values.get('RESUME_FROM_AD_NAME', '')}",
        f"SCHEDULE_TIME={values.get('SCHEDULE_TIME', '05:00')}",
        f"LANDING_PATH_NUMBER={values.get('LANDING_PATH_NUMBER', '100')}",
        f"REPURELY_BASE_URL={values.get('REPURELY_BASE_URL', 'https://repurely.com/surl/P')}",
        f"NAMING_ADSET_TEMPLATE={values.get('NAMING_ADSET_TEMPLATE', '')}",
        f"NAMING_AD_TEMPLATE={values.get('NAMING_AD_TEMPLATE', '')}",
        "",
        f"ENABLE_DESKTOP_ALERT={values.get('ENABLE_DESKTOP_ALERT', NOTIFICATION_DEFAULTS['ENABLE_DESKTOP_ALERT'])}",
        f"NOTIFY_ON_SUCCESS={values.get('NOTIFY_ON_SUCCESS', NOTIFICATION_DEFAULTS['NOTIFY_ON_SUCCESS'])}",
        f"NOTIFY_ON_ERROR={values.get('NOTIFY_ON_ERROR', NOTIFICATION_DEFAULTS['NOTIFY_ON_ERROR'])}",
        f"NOTIFY_ON_STOP={values.get('NOTIFY_ON_STOP', NOTIFICATION_DEFAULTS['NOTIFY_ON_STOP'])}",
        f"NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT={values.get('NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT', NOTIFICATION_DEFAULTS['NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT'])}",
        f"NOTIFICATION_APP_NAME={values.get('NOTIFICATION_APP_NAME', NOTIFICATION_DEFAULTS['NOTIFICATION_APP_NAME'])}",
        f"NOTIFICATION_SUCCESS_TITLE={values.get('NOTIFICATION_SUCCESS_TITLE', NOTIFICATION_DEFAULTS['NOTIFICATION_SUCCESS_TITLE'])}",
        f"NOTIFICATION_ERROR_TITLE={values.get('NOTIFICATION_ERROR_TITLE', NOTIFICATION_DEFAULTS['NOTIFICATION_ERROR_TITLE'])}",
        f"NOTIFICATION_TIMEOUT_TITLE={values.get('NOTIFICATION_TIMEOUT_TITLE', NOTIFICATION_DEFAULTS['NOTIFICATION_TIMEOUT_TITLE'])}",
        "",
        f"WAIT_BASE_RETRY_COUNT={values.get('WAIT_BASE_RETRY_COUNT', '5')}",
        f"WAIT_BASE_RETRY_INTERVAL_MS={values.get('WAIT_BASE_RETRY_INTERVAL_MS', '1500')}",
        f"WAIT_EXTENDED_RETRY_COUNT={values.get('WAIT_EXTENDED_RETRY_COUNT', '5')}",
        f"WAIT_EXTENDED_RETRY_INTERVAL_MS={values.get('WAIT_EXTENDED_RETRY_INTERVAL_MS', '7000')}",
        f"VIDEO_UPLOAD_TIMEOUT_MS={values.get('VIDEO_UPLOAD_TIMEOUT_MS', '180000')}",
        f"VIDEO_UPLOAD_FALLBACK_WAIT_MS={values.get('VIDEO_UPLOAD_FALLBACK_WAIT_MS', '90000')}",
        f"AUTO_RESUME_RECOVERABLE_ERRORS={values.get('AUTO_RESUME_RECOVERABLE_ERRORS', 'true')}",
        f"AUTO_RESUME_MAX_ATTEMPTS={values.get('AUTO_RESUME_MAX_ATTEMPTS', '3')}",
        f"AUTO_RESUME_WAIT_MS={values.get('AUTO_RESUME_WAIT_MS', '10000')}",
        f"MODE_01_WAIT_MS={values.get('MODE_01_WAIT_MS', '10000')}",
        f"MODE_02_WAIT_MS={values.get('MODE_02_WAIT_MS', '5000')}",
        f"MODE_03_WAIT_MS={values.get('MODE_03_WAIT_MS', '12000')}",
        f"MODE_04_WAIT_MS={values.get('MODE_04_WAIT_MS', '6000')}",
        f"MODE_BLOG_VIDEO_WAIT_MS={values.get('MODE_BLOG_VIDEO_WAIT_MS', '12000')}",
        "",
    ]

    if mode in {"BLOG_MIXED", "BLOG_VIDEO", "BLOG_VIDEO_DIRECT"}:
        is_blog_video = mode in {"BLOG_VIDEO", "BLOG_VIDEO_DIRECT"}
        blog_actual_creatives = int(values.get("AD_CREATIVE_COUNT", "4") or "4") + 1
        blog_image_creatives = 0 if is_blog_video else max(blog_actual_creatives - 1, 1)
        blog_video_creatives = blog_actual_creatives if is_blog_video else 1
        lines.extend(
            [
                f"AD_CREATIVE_COUNT={values.get('AD_CREATIVE_COUNT', '4')}",
                f"BLOG_IMAGE_ADS_PER_ADSET={blog_image_creatives}",
                f"BLOG_VIDEO_ADS_PER_ADSET={blog_video_creatives}",
                f"BLOG_TOTAL_ADS_PER_ADSET={blog_actual_creatives}",
                f"BLOG_ADSET_NAME_PREFIX={'f_v_b_o_l' if is_blog_video else 'f_i_b_o_l'}",
                f"BLOG_ADSET_NAME_TEMPLATE={values.get('BLOG_ADSET_NAME_TEMPLATE', '')}",
                "BLOG_IMAGE_AD_NAME_PREFIX=f_i_b_o_l",
                f"BLOG_VIDEO_AD_NAME_PREFIX={'f_v_o_l' if is_blog_video and mode == 'BLOG_VIDEO_DIRECT' else 'f_v_b_o_l'}",
                f"AD_FORMAT={'video' if is_blog_video else 'image'}",
                "DATE_FORMAT=MMDD",
                "BLOG_ASSET_MATCH_MODE=exact",
                "",
                f"BLOG_ASSET_ROOT={values.get('BLOG_ASSET_ROOT', '')}",
                "",
            ]
        )
        adset_count = int(values.get("ADSET_COUNT", "1") or "1")
        for index in range(1, adset_count + 1):
            lines.append(f"BLOG_LANDING_URL_{index}={values.get(f'BLOG_LANDING_URL_{index}', '')}")
            image_dir = values.get(f"BLOG_ADSET_{index}_IMAGE_DIR", "")
            video_dir = values.get(f"BLOG_ADSET_{index}_VIDEO_DIR", "")
            if image_dir:
                lines.append(f"BLOG_ADSET_{index}_IMAGE_DIR={image_dir}")
            if video_dir:
                lines.append(f"BLOG_ADSET_{index}_VIDEO_DIR={video_dir}")
        lines.append("")
    elif mode == "VIDEO_ONLY":
        lines.extend(
            [
                f"AD_CREATIVE_COUNT={values.get('AD_CREATIVE_COUNT', '1')}",
                "AD_FORMAT=video",
                "VIDEO_ONLY_AD_NAME_PREFIX=f_v_o_l",
                "DATE_FORMAT=MMDD",
                f"VIDEO_ONLY_ASSET_ROOT={values.get('VIDEO_ONLY_ASSET_ROOT', '')}",
                "",
            ]
        )
    elif mode in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"}:
        is_image_cbo = mode == "IMAGE_ONLY_CBO"
        mode_prefix = "IMAGE_ONLY_CBO" if is_image_cbo else "VIDEO_ONLY_CBO"
        folder_key = "IMAGE_ONLY_CBO_IMAGE_FOLDER" if is_image_cbo else "VIDEO_ONLY_CBO_VIDEO_FOLDER"
        ad_prefix_key = "IMAGE_ONLY_CBO_AD_NAME_PREFIX" if is_image_cbo else "VIDEO_ONLY_CBO_AD_NAME_PREFIX"
        ad_prefix_value = "f_i_b_o_l" if is_image_cbo else "f_v_b_o_l"
        lines.extend(
            [
                f"AD_CREATIVE_COUNT={values.get('AD_CREATIVE_COUNT', '0')}",
                f"AD_FORMAT={'image' if is_image_cbo else 'video'}",
                f"{ad_prefix_key}={ad_prefix_value}",
                "DATE_FORMAT=MMDD",
                f"CAMPAIGN_BUDGET={values.get('CAMPAIGN_BUDGET', '')}",
                f"{folder_key}={values.get(folder_key, '')}",
                f"{mode_prefix}_AUTO_LANDING_URL=true",
                "",
            ]
        )
        adset_count = int(values.get("ADSET_COUNT", "0") or "0") + 1
        creative_count = int(values.get("AD_CREATIVE_COUNT", "0") or "0") + 1
        for index in range(1, adset_count + 1):
            key = f"{mode_prefix}_ADSET_NAME_{index}"
            lines.append(f"{key}={values.get(key, '')}")
        for index in range(1, adset_count * creative_count + 1):
            key = f"{mode_prefix}_AD_NAME_{index}"
            lines.append(f"{key}={values.get(key, '')}")
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
    if not IS_WINDOWS:
        raise RuntimeError("PowerShell automation launcher is available only on the local Windows PC.")
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
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )


def powershell_quote(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def infer_profile_slot(profile_dir: str) -> str:
    folder_name = Path(profile_dir or DEFAULT_CHROME_PROFILE_DIR).name.lower()
    if folder_name in CHROME_PROFILE_SLOTS:
        return folder_name
    return "custom"


def cdp_port(cdp_url: str) -> str:
    match = re.search(r":(\d+)(?:/|$)", cdp_url or "")
    return match.group(1) if match else "9222"


def build_chrome_cdp_command(chrome_path: str, profile_dir: str, cdp_url: str, url: str) -> str:
    port = cdp_port(cdp_url)
    args = [
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--new-window",
        "--no-first-run",
        url,
    ]
    arg_list = ", ".join(powershell_quote(arg) for arg in args)
    return f"Start-Process -FilePath {powershell_quote(chrome_path)} -ArgumentList @({arg_list})"


def build_automation_command(env_path: Path) -> str:
    return f"$env:DOTENV_CONFIG_PATH = {powershell_quote(env_path)}; npm run open-campaign"


def write_run_env_snapshot(values: dict[str, str], profile_slot: str) -> tuple[Path, str]:
    RUN_ENV_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_profile = re.sub(r"[^A-Za-z0-9_-]+", "_", profile_slot or "profile")
    snapshot_path = RUN_ENV_DIR / f"run-{timestamp}-{safe_profile}.env"
    return snapshot_path, write_env(values, snapshot_path)


def latest_failed_resume_point() -> dict[str, str]:
    summary_files = sorted(
        (APP_DIR / "logs").glob("run-summary-*.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for summary_file in summary_files:
        try:
            payload = json.loads(summary_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if payload.get("status") != "error":
            continue
        context = payload.get("context") or {}
        ad_index = context.get("current_ad_index")
        ad_name = context.get("current_ad_name")
        if ad_index and ad_name:
            return {
                "RESUME_FROM_AD_INDEX": str(ad_index),
                "RESUME_FROM_AD_NAME": str(ad_name),
                "CURRENT_STEP": str(context.get("current_step") or ""),
                "CURRENT_ADSET_NAME": str(context.get("current_adset_name") or ""),
                "SUMMARY_FILE": str(summary_file),
            }
    return {}


def default_blog_root() -> str:
    mmdd = datetime.now().strftime("%m%d")
    return str(Path.home() / "Desktop" / f"F_I_B_O_L_{mmdd}")


def default_image_root() -> str:
    mmdd = datetime.now().strftime("%m%d")
    return str(Path.home() / "Desktop" / f"F_I_O_L_{mmdd}")


def default_video_root() -> str:
    yymmdd = datetime.now().strftime("%y%m%d")
    return str(Path.home() / "Desktop" / f"{yymmdd} 올레놀샷 틱톡세팅")


def expected_blog_folder_name(adset_index: int, budget: str, schedule_time: str, image_count: int = 4) -> str:
    mmdd = datetime.now().strftime("%m%d")
    budget_manwon = int(int(budget or "0") / 10000)
    hour = schedule_time.split(":", 1)[0].zfill(2)
    return f"{mmdd} {adset_index}번 광고세트-일예산 {budget_manwon}만원-이미지 {image_count}개 + 영상 1개 익일 {hour}시"


def expected_blog_video_folder_name(adset_index: int, budget: str, schedule_time: str, video_count: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    budget_manwon = int(int(budget or "0") / 10000)
    hour = schedule_time.split(":", 1)[0].zfill(2)
    return f"{mmdd} {adset_index}번 광고세트-일예산 {budget_manwon}만원-영상 {video_count}개 익일 {hour}시"


def build_blog_adset_name(index: int, video: bool = False, template: str = "") -> str:
    mmdd = datetime.now().strftime("%m%d")
    if template.strip():
        return template.strip().replace("{mmdd}", mmdd).replace("{date}", mmdd).replace("{index}", str(index))
    prefix = "f_v_b_o_l" if video else "f_i_b_o_l"
    return f"{prefix}_{mmdd}_{index}"


def build_blog_image_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_i_b_o_l_{mmdd}_{index}"


def build_blog_video_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_v_b_o_l_{mmdd}_{index}"


def build_blog_video_direct_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_v_o_l_{mmdd}_{index}"


def expected_image_folder_name(adset_index: int, budget: str, creative_count: int, schedule_time: str) -> str:
    budget_manwon = int(int(budget or "0") / 10000)
    hour = schedule_time.split(":", 1)[0].zfill(2)
    return f"메타 리타겟 소재-{adset_index}번 세트-일예산 {budget_manwon}만원_익일 {hour}시 세팅"


def build_image_only_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_i_o_l_{mmdd}_{index}"


def expected_video_folder_name() -> str:
    yymmdd = datetime.now().strftime("%y%m%d")
    return f"{yymmdd} 올레놀샷 틱톡세팅"


def expected_video_child_folder_name() -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"{mmdd} 올레놀샷 CBO 캠페인-1"


def format_budget_preview(value: str) -> str:
    raw = str(value or "").replace(",", "").strip()
    if not raw.isdigit() or int(raw) <= 0:
        return ""
    return f"{int(raw):,}"


def build_video_only_cbo_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_v_b_o_l_{mmdd}_{index}"


def build_image_only_cbo_ad_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"f_i_b_o_l_{mmdd}_{index}"


def build_video_only_cbo_adset_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"{mmdd} CBO 광고세트 -{index}"


def build_image_only_cbo_adset_name(index: int) -> str:
    mmdd = datetime.now().strftime("%m%d")
    return f"{mmdd} CBO 광고세트 -{index}"


def default_landing_url(ad_name: str, path_number: str = "100") -> str:
    path = str(path_number or "100").strip()
    if not path.isdigit():
        path = "100"
    return f"https://repurely.com/surl/P/{path}?utm_source=f&utm_medium=f&utm_campaign={ad_name}"

def find_video_file_for_preview(ad_name: str, folder: str) -> tuple[str, list[str]]:
    expected = [f"{ad_name}.mp4", f"{ad_name}.mov", f"{ad_name}.m4v"]
    folder_path = Path(folder).expanduser()
    for filename in expected:
        candidate = folder_path / filename
        if candidate.exists():
            return str(candidate), expected
    return "", expected


def find_image_file_for_preview(ad_name: str, folder: str) -> tuple[str, list[str]]:
    expected = [f"{ad_name}.png", f"{ad_name}.jpg", f"{ad_name}.jpeg", f"{ad_name}.webp", f"{ad_name}.gif"]
    folder_path = Path(folder).expanduser()
    for filename in expected:
        candidate = folder_path / filename
        if candidate.exists():
            return str(candidate), expected
    return "", expected


def list_video_stems_for_preview(folder: str) -> list[str]:
    folder_path = Path(folder).expanduser()
    if not folder_path.exists() or not folder_path.is_dir():
        return []
    files = [
        item
        for item in folder_path.iterdir()
        if item.is_file() and item.suffix.lower() in [".mp4", ".mov", ".m4v"]
    ]
    return [item.stem for item in sorted(files, key=lambda item: item.name.lower())]


def list_video_files_for_preview(folder: str) -> list[str]:
    folder_path = Path(folder).expanduser()
    if not folder_path.exists() or not folder_path.is_dir():
        return []
    files = [
        item.name
        for item in folder_path.iterdir()
        if item.is_file() and item.suffix.lower() in [".mp4", ".mov", ".m4v", ".webm"]
    ]
    return sorted(files, key=lambda name: [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)])


def list_image_stems_for_preview(folder: str) -> list[str]:
    folder_path = Path(folder).expanduser()
    if not folder_path.exists() or not folder_path.is_dir():
        return []
    files = [
        item
        for item in folder_path.iterdir()
        if item.is_file() and item.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp", ".gif"]
    ]
    return [item.stem for item in sorted(files, key=lambda item: item.name.lower())]


def read_child_folder_names(root: str, limit: int) -> list[str]:
    root_path = Path(root).expanduser()
    if not root_path.exists() or not root_path.is_dir():
        return []

    folders = [item.name for item in root_path.iterdir() if item.is_dir()]
    return sorted(folders, key=folder_sort_key)[:limit]


def folder_sort_key(folder_name: str) -> tuple[int, str]:
    patterns = [
        r"메타\s*리타겟\s*소재\s*-\s*(\d+)\s*번\s*세트",
        r"(\d+)\s*번\s*세트",
        r"(\d+)\s*번\s*광고세트",
        r"adset[_\-\s]*(\d+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, folder_name, flags=re.IGNORECASE)
        if match:
            return int(match.group(1)), folder_name
    return 999999, folder_name


def validate_form(values: dict[str, str]) -> list[str]:
    errors: list[str] = []
    if not values.get("CAMPAIGN_NAME", "").strip():
        errors.append("CAMPAIGN_NAME is required.")
    if not values.get("AD_ACCOUNT_ID", "").strip():
        errors.append("AD_ACCOUNT_ID is required.")
    if values.get("CAMPAIGN_MODE") in {"BLOG_MIXED", "BLOG_VIDEO", "BLOG_VIDEO_DIRECT"}:
        mode = values.get("CAMPAIGN_MODE")
        if not values.get("BLOG_ASSET_ROOT", "").strip():
            errors.append(f"BLOG_ASSET_ROOT is required for {mode}.")
        elif mode in {"BLOG_VIDEO", "BLOG_VIDEO_DIRECT"}:
            root = values.get("BLOG_ASSET_ROOT", "").strip()
            adset_count = int(values.get("ADSET_COUNT", "1") or "1")
            videos_per_adset = int(values.get("AD_CREATIVE_COUNT", "4") or "4") + 1
            required_videos = adset_count * videos_per_adset
            flat_videos = list_video_files_for_preview(root)
            has_adset_folders = all(
                len(list_video_files_for_preview(str(Path(root).expanduser() / f"adset_{index}" / "videos"))) == videos_per_adset
                for index in range(1, adset_count + 1)
            )
            if len(flat_videos) < required_videos and not has_adset_folders:
                errors.append(f"BLOG_VIDEO requires {required_videos} root videos or {videos_per_adset} videos in each adset_N/videos folder. Found {len(flat_videos)} root videos.")
        adset_count = int(values.get("ADSET_COUNT", "1") or "1")
        if mode == "BLOG_VIDEO_DIRECT":
            if not str(values.get("LANDING_PATH_NUMBER", "100")).strip().isdigit():
                errors.append("LANDING_PATH_NUMBER must be a positive number.")
        else:
            for index in range(1, adset_count + 1):
                if not values.get(f"BLOG_LANDING_URL_{index}", "").strip():
                    errors.append(f"BLOG_LANDING_URL_{index} is required.")
    elif values.get("CAMPAIGN_MODE") == "IMAGE_ONLY":
        if not str(values.get("LANDING_PATH_NUMBER", "100")).strip().isdigit():
            errors.append("LANDING_PATH_NUMBER must be a positive number.")
        if values.get("IMAGE_ONLY_UPLOAD_MODE") != "LEGACY" and not (values.get("IMAGE_ONLY_ASSET_ROOT", "").strip() or values.get("MEDIA_FOLDER_PATH", "").strip()):
            errors.append("IMAGE_ONLY per-ad upload requires IMAGE_ONLY_ASSET_ROOT or MEDIA_FOLDER_PATH.")
    elif values.get("CAMPAIGN_MODE") == "VIDEO_ONLY":
        if not values.get("VIDEO_ONLY_ASSET_ROOT", "").strip():
            errors.append("VIDEO_ONLY_ASSET_ROOT is required for VIDEO_ONLY.")
    elif values.get("CAMPAIGN_MODE") in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"}:
        mode = values.get("CAMPAIGN_MODE")
        is_image_cbo = mode == "IMAGE_ONLY_CBO"
        mode_prefix = "IMAGE_ONLY_CBO" if is_image_cbo else "VIDEO_ONLY_CBO"
        folder_key = "IMAGE_ONLY_CBO_IMAGE_FOLDER" if is_image_cbo else "VIDEO_ONLY_CBO_VIDEO_FOLDER"
        folder_label = "Image folder" if is_image_cbo else "Video folder"
        budget_preview = format_budget_preview(values.get("CAMPAIGN_BUDGET", ""))
        if not budget_preview:
            errors.append(f"Campaign budget must be a positive integer for {mode}.")
        if not str(values.get("LANDING_PATH_NUMBER", "100")).strip().isdigit():
            errors.append("LANDING_PATH_NUMBER must be a positive number.")
        media_folder = values.get(folder_key, "").strip()
        if not media_folder:
            errors.append(f"{folder_label} is required for {mode}.")
        elif not Path(media_folder).expanduser().exists():
            errors.append(f"{folder_label} does not exist: {media_folder}")

        adset_total = 1
        creative_total = int(values.get("AD_CREATIVE_COUNT", "0") or "0") + 1
        names: list[str] = []
        for index in range(1, adset_total * creative_total + 1):
            ad_name = values.get(f"{mode_prefix}_AD_NAME_{index}", "").strip() or (build_image_only_cbo_ad_name(index) if is_image_cbo else build_video_only_cbo_ad_name(index))
            if ad_name in names:
                errors.append(f"Duplicate ad name: {ad_name}")
            names.append(ad_name)
            media_file, expected = (find_image_file_for_preview(ad_name, media_folder) if is_image_cbo else find_video_file_for_preview(ad_name, media_folder))
            if not media_file:
                media_type = "Image" if is_image_cbo else "Video"
                errors.append(f"{media_type} file not found for ad name: {ad_name}. Expected one of: {', '.join(expected)}")
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

title_col, guide_col = st.columns([0.62, 0.38], vertical_alignment="center")
with title_col:
    st.title("Meta Ads Automation")
with guide_col:
    st.caption(
        "회사 공유 사용 안내: Streamlit Cloud는 설정/프리뷰용이고, 실제 Meta 자동화는 각자 Windows PC에서 로컬 실행해야 합니다."
    )

with st.expander("회사 사람들과 같이 쓰는 방법"):
    st.markdown(
        """
        - Streamlit Cloud 앱은 입력값 확인, preview, URL 예시 확인용입니다.
        - 실제 자동화는 각 사용자 PC의 Chrome 로그인 세션, 로컬 소재 폴더, PowerShell을 사용하므로 각자 Windows PC에서 실행해야 합니다.
        - 처음 쓰는 사람은 GitHub 저장소를 받은 뒤 `npm install`, `pip install -r requirements.txt`, `streamlit run streamlit_app.py` 순서로 실행합니다.
        - 각 사용자는 자기 PC에서 `.env`를 따로 저장하고, 자기 Meta 계정으로 Chrome CDP를 열어 자동화를 실행합니다.
        - 업데이트가 필요할 때는 로컬 폴더에서 `git pull origin main` 후 다시 Streamlit을 실행하면 됩니다.
        """
    )

env = read_env()
if "resume_mode_enabled" not in st.session_state:
    st.session_state.resume_mode_enabled = False

mode_01_wait_ms = int(env.get("MODE_01_WAIT_MS", "10000") or "10000")
mode_02_wait_ms = int(env.get("MODE_02_WAIT_MS", "5000") or "5000")
mode_03_wait_ms = int(env.get("MODE_03_WAIT_MS", "12000") or "12000")
mode_04_wait_ms = int(env.get("MODE_04_WAIT_MS", "6000") or "6000")
mode_blog_video_wait_ms = int(env.get("MODE_BLOG_VIDEO_WAIT_MS", "12000") or "12000")
auto_resume_wait_ms = int(env.get("AUTO_RESUME_WAIT_MS", "10000") or "10000")

with st.expander("공통 wait/retry 설정", expanded=False):
    st.caption("자주 조정하는 값만 남겼습니다. 괄호 안에 실제 초 단위를 같이 표시합니다.")
    wait_base_retry_count = st.number_input("기본 재시도 횟수", min_value=1, max_value=20, value=int(env.get("WAIT_BASE_RETRY_COUNT", "5") or "5"))
    wait_base_retry_interval = st.number_input("기본 재시도 간격(ms)", min_value=500, max_value=10000, value=int(env.get("WAIT_BASE_RETRY_INTERVAL_MS", "1500") or "1500"), step=500)
    st.caption(f"기본 재시도 간격: {ms_caption(wait_base_retry_interval)}")
    wait_extended_retry_count = st.number_input("확장 재시도 횟수", min_value=1, max_value=20, value=int(env.get("WAIT_EXTENDED_RETRY_COUNT", "5") or "5"))
    wait_extended_retry_interval = st.number_input("확장 재시도 간격(ms)", min_value=1000, max_value=30000, value=int(env.get("WAIT_EXTENDED_RETRY_INTERVAL_MS", "7000") or "7000"), step=1000)
    st.caption(f"확장 재시도 간격: {ms_caption(wait_extended_retry_interval)}")
    video_upload_timeout_ms = st.number_input("영상 업로드 확인 timeout(ms)", min_value=30000, max_value=300000, value=int(env.get("VIDEO_UPLOAD_TIMEOUT_MS", "180000") or "180000"), step=10000)
    st.caption(f"영상 업로드 확인 timeout: {ms_caption(video_upload_timeout_ms)}")
    video_upload_fallback_wait_ms = st.number_input("영상 fallback 대기(ms)", min_value=30000, max_value=120000, value=int(env.get("VIDEO_UPLOAD_FALLBACK_WAIT_MS", "90000") or "90000"), step=10000)
    st.caption(f"영상 fallback 대기: {ms_caption(video_upload_fallback_wait_ms)}")
    auto_resume_recoverable_errors = st.toggle(
        "버튼/업로드 오류 자동 이어가기",
        value=env_bool(env, "AUTO_RESUME_RECOVERABLE_ERRORS", "true"),
        help="광고 편집 중 다음/계속/완료/업로드/영상 처리 타임아웃처럼 이어가기 가능한 오류가 나면 현재 광고명부터 자동 재실행합니다.",
    )
    auto_resume_max_attempts = st.number_input("자동 이어가기 최대 횟수", min_value=0, max_value=10, value=int(env.get("AUTO_RESUME_MAX_ATTEMPTS", "3") or "3"))
    with st.expander("모드별 내부 대기값 보기", expanded=False):
        st.caption(
            f"BLOG_MIXED {ms_caption(mode_01_wait_ms)} / "
            f"IMAGE_ONLY {ms_caption(mode_02_wait_ms)} / "
            f"VIDEO_ONLY_CBO {ms_caption(mode_03_wait_ms)} / "
            f"IMAGE_ONLY_CBO {ms_caption(mode_04_wait_ms)} / "
            f"BLOG_VIDEO {ms_caption(mode_blog_video_wait_ms)}"
        )

with st.expander("실패 지점부터 재실행", expanded=False):
    st.caption("광고명 변경/소재 업로드 중 중단된 경우, 실패한 광고명을 그대로 입력하면 그 광고명부터 다시 찾고 이어서 처리합니다.")
    latest_resume = latest_failed_resume_point()
    if latest_resume:
        st.write(
            f"최근 실패 지점: `{latest_resume['RESUME_FROM_AD_NAME']}` "
            f"(index `{latest_resume['RESUME_FROM_AD_INDEX']}`, step `{latest_resume['CURRENT_STEP']}`)"
        )
        if st.button("Load latest failed resume point"):
            updated_env = {**env, **latest_resume}
            updated_env.pop("CURRENT_STEP", None)
            updated_env.pop("CURRENT_ADSET_NAME", None)
            updated_env.pop("SUMMARY_FILE", None)
            write_env(updated_env)
            st.session_state.resume_mode_enabled = True
            st.success(f"Resume point saved: {latest_resume['RESUME_FROM_AD_NAME']}")
            st.toast("실패 지점을 .env에 저장했습니다. 새 터미널로 이어서 실행할 수 있어요.")
            st.rerun()
    else:
        st.caption("최근 실패 run-summary를 아직 찾지 못했습니다.")
    resume_mode_enabled = st.checkbox(
        "Resume mode 사용",
        value=st.session_state.resume_mode_enabled,
        help="신규 실행이면 반드시 꺼두세요. 켜져 있을 때만 RESUME_FROM_AD_INDEX/NAME이 .env에 저장됩니다.",
    )
    st.session_state.resume_mode_enabled = resume_mode_enabled
    resume_from_ad_name_input = st.text_input(
        "실패한 광고명 또는 다시 시작할 광고명",
        value=env.get("RESUME_FROM_AD_NAME", ""),
        disabled=not resume_mode_enabled,
        help="알림에 나온 광고명을 그대로 넣으세요. 예: f_v_b_o_l_0526_15",
    )
    saved_resume_index = max(1, int(env.get("RESUME_FROM_AD_INDEX", "1") or "1"))
    inferred_resume_index = saved_resume_index
    resume_name_match = re.search(r"_(\d+)$", resume_from_ad_name_input.strip())
    if resume_name_match:
        inferred_resume_index = int(resume_name_match.group(1))
    manual_resume_index = st.number_input(
        "광고명에서 번호를 읽지 못할 때만 직접 입력",
        min_value=1,
        max_value=10000,
        value=inferred_resume_index,
        disabled=not resume_mode_enabled or bool(resume_name_match),
        help="보통은 광고명 끝의 _15 같은 숫자를 자동으로 사용합니다.",
    )
    resume_from_ad_index_input = inferred_resume_index if resume_name_match else manual_resume_index
    st.metric("실제 resume ad index", resume_from_ad_index_input)
    st.caption("광고세트명은 선택하지 않습니다. 입력한 광고명 row를 직접 찾아서 그 지점부터 이어갑니다.")
    resume_from_ad_index = resume_from_ad_index_input if resume_mode_enabled else 1
    resume_from_ad_name = resume_from_ad_name_input if resume_mode_enabled else ""
    if not resume_mode_enabled and (env.get("RESUME_FROM_AD_NAME") or env.get("RESUME_FROM_AD_INDEX", "1") not in {"", "1"}):
        st.warning("현재 화면은 신규 실행 모드입니다. Save .env를 누르면 남아 있던 resume 값이 비워집니다.")
    st.info("재실행 전에는 Meta 화면에서 실패한 캠페인 편집 화면이 열려 있거나, 기존 자동화가 해당 캠페인을 다시 열 수 있는 상태여야 합니다.")

with st.sidebar:
    st.subheader("Actions")
    if not IS_WINDOWS:
        st.info("Cloud mode: Windows-only local automation buttons are disabled. Use this page for settings and preview, then run automation on your local PC.")
    if st.button("Pull latest code"):
        command = ["git", "pull", "origin", "main"]
        code, output = run_command(command)
        show_command_result("git pull", command, code, output)

    if st.button("Install npm packages", disabled=not IS_WINDOWS):
        command = ["npm.cmd" if IS_WINDOWS else "npm", "install"]
        code, output = run_command(command, timeout=600)
        show_command_result("npm install", command, code, output)

    if st.button("Open .env in VS Code", disabled=not IS_WINDOWS):
        subprocess.Popen(["code.cmd", str(ENV_PATH)], cwd=APP_DIR, shell=False)
        st.info(".env open requested.")

    default_profile_slot = infer_profile_slot(env.get("CHROME_PROFILE_DIR", DEFAULT_CHROME_PROFILE_DIR))
    profile_options = ["profile_01", "profile_02", "profile_03", "custom"]
    profile_slot = st.selectbox(
        "Chrome profile slot",
        profile_options,
        index=profile_options.index(default_profile_slot),
        help="프로필마다 별도 Chrome 프로세스와 CDP 포트를 사용합니다. profile_01=9222, profile_02=9223, profile_03=9224.",
    )
    if profile_slot == "custom":
        chrome_profile_dir = st.text_input(
            "Chrome profile directory",
            value=env.get("CHROME_PROFILE_DIR", DEFAULT_CHROME_PROFILE_DIR),
            help="Meta 로그인 세션을 저장할 Chrome 프로필 폴더입니다.",
        )
        cdp_url_default = env.get("CDP_URL", "http://127.0.0.1:9222")
    else:
        chrome_profile_dir = CHROME_PROFILE_SLOTS[profile_slot]["dir"]
        st.text_input(
            "Chrome profile directory",
            value=chrome_profile_dir,
            disabled=True,
            help="선택한 profile slot에 맞춰 자동 지정됩니다.",
        )
        cdp_url_default = CHROME_PROFILE_SLOTS[profile_slot]["cdp_url"]

    cdp_url = st.text_input(
        "CDP URL",
        value=cdp_url_default,
        help="선택한 Chrome profile slot과 같은 포트여야 합니다. profile_02는 9223, profile_03은 9224를 권장합니다.",
    )

    if st.button("Open Chrome CDP", disabled=not IS_WINDOWS):
        account_id = env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID)
        url = f"{ADS_MANAGER_URL}?act={account_id}"
        chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        command = build_chrome_cdp_command(chrome, chrome_profile_dir, cdp_url, url)
        try:
            start_powershell(command)
            st.info(f"Chrome CDP opened: {profile_slot} / {cdp_url} / {chrome_profile_dir}")
        except Exception as exc:
            st.error(f"Chrome CDP launcher is unavailable here: {exc}")

    if st.button("Open automation terminal", disabled=not IS_WINDOWS):
        try:
            start_powershell("npm run open-campaign")
            st.info("Automation PowerShell opened with current .env. For isolated runs, use Run real automation terminal below.")
        except Exception as exc:
            st.error(f"Automation terminal launcher is unavailable here: {exc}")

    st.subheader("Notifications")
    enable_desktop_alert = st.toggle(
        "데스크톱 알림 사용",
        value=env_bool(env, "ENABLE_DESKTOP_ALERT", NOTIFICATION_DEFAULTS["ENABLE_DESKTOP_ALERT"]),
    )
    notify_on_success = st.toggle(
        "작업 완료 시 알림",
        value=env_bool(env, "NOTIFY_ON_SUCCESS", NOTIFICATION_DEFAULTS["NOTIFY_ON_SUCCESS"]),
    )
    notify_on_error = st.toggle(
        "에러 발생 시 알림",
        value=env_bool(env, "NOTIFY_ON_ERROR", NOTIFICATION_DEFAULTS["NOTIFY_ON_ERROR"]),
    )
    notify_on_stop = st.toggle(
        "검증/중단 시 알림",
        value=env_bool(env, "NOTIFY_ON_STOP", NOTIFICATION_DEFAULTS["NOTIFY_ON_STOP"]),
    )
    notify_on_video_upload_timeout = st.toggle(
        "영상 업로드 타임아웃 알림",
        value=env_bool(env, "NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT", NOTIFICATION_DEFAULTS["NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT"]),
    )

    st.divider()
    st.markdown(
        """
        <div style="font-size:0.82rem; line-height:1.45; color:rgba(49,51,63,0.70);">
          <div style="margin-bottom:5.2px;">Meta Ads Automation</div>
          <a href="https://repurely.com/" target="_blank" style="display:block; margin-bottom:5.2px; color:inherit; text-decoration:none;">https://repurely.com</a>
          <div>@memeanji</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


st.subheader("Campaign Builder")
st.caption("Campaign mode를 직접 고르지 않고, 캠페인 생성 여부/구조/소재 타입/URL 방식을 조합하면 기존 자동화 모드로 변환됩니다.")

base_col, structure_col = st.columns(2)
with base_col:
    dry_run = st.toggle("DRY_RUN", value=env.get("DRY_RUN", "true").lower() == "true")
    ad_account_id = st.text_input("Ad account ID", value=env.get("AD_ACCOUNT_ID", DEFAULT_ACCOUNT_ID))
    create_new_campaign = st.toggle(
        "새 캠페인 생성",
        value=env.get("CAMPAIGN_MODE", "IMAGE_ONLY") in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"},
        help="끄면 기존 캠페인을 검색해서 그 안에 광고세트를 추가합니다.",
    )
    campaign_name = st.text_input(
        "Campaign name",
        value=env.get("CAMPAIGN_NAME", ""),
        help="새 캠페인 생성 시 만들 캠페인명, 기존 캠페인 추가 시 검색할 캠페인명입니다.",
    )
    daily_budget = st.text_input("Daily budget", value=env.get("ADSET_DAILY_BUDGET", "300000"))
    schedule_time = st.text_input("Schedule time", value=env.get("SCHEDULE_TIME", "05:00"))
    st.caption(f"Chrome CDP: `{profile_slot}` / `{cdp_url}`")

with structure_col:
    campaign_structure = "ABO"
    campaign_budget = env.get("CAMPAIGN_BUDGET", "25000")
    if create_new_campaign:
        campaign_structure = st.radio("Campaign structure", ["CBO", "ABO"], horizontal=True, index=0 if env.get("CAMPAIGN_MODE") in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"} else 1)
        if campaign_structure == "CBO":
            campaign_budget = st.text_input("Campaign budget", value=campaign_budget)
        else:
            st.info("ABO 신규 캠페인 생성은 UI 모델에 준비되어 있지만 현재 Playwright 엔진은 기존 캠페인 append 흐름으로 실행됩니다.")
    else:
        st.info("기존 캠페인에 광고세트를 추가합니다. 캠페인 구조/캠페인 예산 입력은 숨깁니다.")

with st.expander("Naming / URL templates", expanded=True):
    template_col1, template_col2, template_col3 = st.columns(3)
    with template_col1:
        naming_adset_template = st.text_input("Adset template", value=env.get("BLOG_ADSET_NAME_TEMPLATE") or env.get("NAMING_ADSET_TEMPLATE", "f_i_o_l_{MMDD}_{idx}"))
    with template_col2:
        naming_ad_template = st.text_input("Ad template", value=env.get("NAMING_AD_TEMPLATE", "{adset_name}_{ad_idx}"))
    with template_col3:
        repurely_base_url = st.text_input("Repurely base URL", value=env.get("REPURELY_BASE_URL", "https://repurely.com/surl/P"))
    st.caption("지원 토큰: `{MMDD}`, `{YYMMDD}`, `{idx}`, `{ad_idx}`, `{adset_name}`")
    st.caption("mixed 소재는 운영 규칙에 맞춰 광고명이 자동 고정됩니다: 이미지는 `f_i_b_o_l_MMDD_전체번호`, 마지막 영상은 `f_v_b_o_l_MMDD_전체번호`.")

default_mode = env.get("CAMPAIGN_MODE", "IMAGE_ONLY")
default_media = "mixed" if default_mode == "BLOG_MIXED" else ("video" if default_mode in {"BLOG_VIDEO", "BLOG_VIDEO_DIRECT", "VIDEO_ONLY_CBO"} else "image")
default_url_mode = "per_ad_auto" if default_mode in {"BLOG_VIDEO_DIRECT", "VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO", "IMAGE_ONLY", "VIDEO_ONLY"} else "shared_manual"
default_actual_adsets = 1 if default_mode in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"} else max(1, int(env.get("ADSET_COUNT", "1") or "1"))
default_actual_ads = max(1, int(env.get("AD_CREATIVE_COUNT", "4") or "4") + 1)

adset_count = st.number_input("Adset count", min_value=1, max_value=100, value=default_actual_adsets)
adsets: list[dict[str, object]] = []
preview_rows: list[dict[str, object]] = []
ui_errors: list[str] = []
ui_warnings: list[str] = []
tokens = date_tokens()

for adset_index in range(1, int(adset_count) + 1):
    with st.expander(f"Adset #{adset_index}", expanded=adset_index == 1):
        adset_key = f"unified_adset_{adset_index}"
        header_col1, header_col2, header_col3 = st.columns(3)
        with header_col1:
            media_type = st.radio(
                "소재 타입",
                ["image", "video", "mixed"],
                index=["image", "video", "mixed"].index(default_media),
                horizontal=True,
                key=f"{adset_key}_media",
            )
        with header_col2:
            ad_count = st.number_input("광고 개수", min_value=1, max_value=100, value=default_actual_ads, key=f"{adset_key}_ad_count")
        with header_col3:
            url_mode = st.radio(
                "URL 방식",
                ["per_ad_auto", "shared_manual"],
                format_func=lambda value: "광고별 자동" if value == "per_ad_auto" else "세트 공유",
                index=["per_ad_auto", "shared_manual"].index(default_url_mode),
                horizontal=True,
                key=f"{adset_key}_url_mode",
            )

        image_folder = ""
        video_folder = ""
        folder_override = False
        if media_type == "mixed":
            inherited_mixed_root = (
                st.session_state.get("unified_adset_1_mixed_root")
                or env.get("BLOG_ASSET_ROOT")
                or default_video_root()
            )
            if adset_index == 1:
                mixed_root = st.text_input(
                    "소재 루트 폴더",
                    value=env.get("BLOG_ASSET_ROOT") or default_video_root(),
                    key=f"{adset_key}_mixed_root",
                    help="이 폴더 안에 1번 광고세트, 2번 광고세트... 같은 하위 폴더가 들어있는 구조를 권장합니다.",
                )
                st.caption("이 폴더가 나머지 광고세트에도 자동 적용됩니다. 각 광고세트 폴더 안에는 이미지/영상 파일을 함께 넣으면 됩니다.")
            else:
                folder_override = st.checkbox(
                    "이 광고세트만 다른 소재 폴더 사용",
                    value=bool(env.get(f"BLOG_ADSET_{adset_index}_IMAGE_DIR") or env.get(f"BLOG_ADSET_{adset_index}_VIDEO_DIR")),
                    key=f"{adset_key}_folder_override",
                )
                if folder_override:
                    mixed_root = st.text_input(
                        "이 광고세트 소재 폴더",
                        value=env.get(f"BLOG_ADSET_{adset_index}_IMAGE_DIR") or env.get(f"BLOG_ADSET_{adset_index}_VIDEO_DIR") or inherited_mixed_root,
                        key=f"{adset_key}_mixed_root",
                        help="예외 상황에서만 사용하세요. 이 폴더 안에서 광고명과 같은 이미지/영상 파일을 찾습니다.",
                    )
                else:
                    mixed_root = str(inherited_mixed_root)
                    st.caption(f"소재 루트 폴더 자동 적용: `{mixed_root}`")
            image_folder = mixed_root
            video_folder = mixed_root
        else:
            folder_col1, folder_col2 = st.columns(2)
            with folder_col1:
                if media_type == "image":
                    inherited_image_root = (
                        st.session_state.get("unified_adset_1_image_folder")
                        or env.get("IMAGE_ONLY_ASSET_ROOT")
                        or env.get("MEDIA_FOLDER_PATH")
                        or default_image_root()
                    )
                    image_folder = st.text_input(
                        "Image folder",
                        value=inherited_image_root if adset_index > 1 else (env.get("IMAGE_ONLY_ASSET_ROOT") or env.get("MEDIA_FOLDER_PATH") or default_image_root()),
                        key=f"{adset_key}_image_folder",
                    )
            with folder_col2:
                if media_type == "video":
                    inherited_video_root = (
                        st.session_state.get("unified_adset_1_video_folder")
                        or env.get("VIDEO_ONLY_ASSET_ROOT")
                        or env.get("BLOG_ASSET_ROOT")
                        or default_video_root()
                    )
                    video_folder = st.text_input(
                        "Video folder",
                        value=inherited_video_root if adset_index > 1 else (env.get("VIDEO_ONLY_ASSET_ROOT") or env.get("BLOG_ASSET_ROOT") or default_video_root()),
                        key=f"{adset_key}_video_folder",
                    )

        default_path_number = int(env.get("LANDING_PATH_NUMBER", env.get("REPURELY_PATH_NUMBER", "100")) or "100")
        path_numbers: list[int] = []
        shared_landing_url = ""
        if url_mode == "per_ad_auto":
            common_path_options = [100, 99, 67]
            path_col1, path_col2 = st.columns([1, 2])
            with path_col1:
                selected_path_option = st.selectbox(
                    "기본 path number",
                    [*common_path_options, "직접 입력"],
                    index=common_path_options.index(default_path_number) if default_path_number in common_path_options else len(common_path_options),
                    key=f"{adset_key}_path_select",
                    help="선택한 숫자가 광고 개수만큼 자동 적용됩니다. 예: 광고 3개 + 100 선택 → 100 100 100",
                )
            with path_col2:
                custom_path_number = st.number_input(
                    "직접 path number",
                    min_value=1,
                    max_value=999999,
                    value=default_path_number,
                    disabled=selected_path_option != "직접 입력",
                    key=f"{adset_key}_path_custom",
                )
            base_path_number = int(custom_path_number if selected_path_option == "직접 입력" else selected_path_option)
            path_numbers = [base_path_number for _ in range(int(ad_count))]
            edit_path_numbers = st.checkbox(
                "광고별 path number 개별 수정",
                value=False,
                key=f"{adset_key}_path_edit",
                help="대부분은 끄고 사용하면 됩니다. 켜면 광고별로 100 101 102처럼 다르게 넣을 수 있습니다.",
            )
            if edit_path_numbers:
                path_raw = st.text_input(
                    "Path numbers",
                    value=" ".join(str(item) for item in path_numbers),
                    help="광고 개수만큼 입력합니다. 예: 100 101 102",
                    key=f"{adset_key}_paths",
                )
                path_numbers = split_path_numbers(path_raw, int(ad_count), base_path_number)
            else:
                st.caption(f"자동 적용: 광고 {int(ad_count)}개 → path number `{base_path_number}`가 {int(ad_count)}개 모두에 들어갑니다.")
        else:
            shared_landing_url = st.text_area(
                "Shared landing URL",
                value=env.get(f"BLOG_LANDING_URL_{adset_index}", ""),
                placeholder="블로그 URL을 입력하세요",
                key=f"{adset_key}_shared_url",
            ).strip()

        try:
            adset_name = render_template(naming_adset_template, {**tokens, "idx": adset_index})
        except ValueError as exc:
            adset_name = "(template error)"
            ui_errors.append(str(exc))
        st.caption(f"Adset name preview: `{adset_name}`")

        if media_type == "mixed" and int(ad_count) < 2:
            ui_errors.append(f"Adset {adset_index}: mixed는 광고 개수가 2개 이상이어야 합니다.")
        if url_mode == "shared_manual" and not shared_landing_url:
            ui_errors.append(f"Adset {adset_index}: 세트 공유 URL을 입력해 주세요.")
        if url_mode == "per_ad_auto" and len(path_numbers) != int(ad_count):
            ui_errors.append(f"Adset {adset_index}: path number 개수가 광고 개수와 같아야 합니다.")

        for ad_idx in range(1, int(ad_count) + 1):
            media_for_ad = ad_media_type(media_type, ad_idx, int(ad_count))
            global_ad_index = ((adset_index - 1) * int(ad_count)) + ad_idx
            try:
                if media_type == "mixed":
                    ad_name = default_ad_name_for_media(media_for_ad, global_ad_index, tokens["MMDD"])
                else:
                    ad_name = render_template(naming_ad_template, {**tokens, "idx": adset_index, "ad_idx": global_ad_index, "adset_name": adset_name})
                landing_url = build_ad_url(url_mode, shared_landing_url, path_numbers, ad_idx, ad_name, repurely_base_url)
            except (ValueError, IndexError) as exc:
                ad_name = "(template error)"
                landing_url = "(url error)"
                ui_errors.append(str(exc))
            preview_rows.append({
                "adset": adset_index,
                "adset_name": adset_name,
                "ad": ad_idx,
                "media": media_for_ad,
                "ad_name": ad_name,
                "landing_url": landing_url,
            })

        adsets.append({
            "index": adset_index,
            "mediaType": media_type,
            "adCount": int(ad_count),
            "imageFolder": image_folder,
            "videoFolder": video_folder,
            "folderOverride": folder_override,
            "urlMode": url_mode,
            "pathNumbers": path_numbers,
            "sharedLandingUrl": shared_landing_url,
        })

media_types = [str(item["mediaType"]) for item in adsets]
url_modes = [str(item["urlMode"]) for item in adsets]
campaign_mode, mapping_warnings = derive_legacy_mode(create_new_campaign, campaign_structure, media_types, url_modes)
ui_warnings.extend(mapping_warnings)

ad_counts = {int(item["adCount"]) for item in adsets}
if len(ad_counts) > 1:
    ui_warnings.append("현재 Playwright 엔진은 한 실행 안에서 광고세트별 서로 다른 광고 개수를 지원하지 않습니다. 같은 광고 개수로 맞춰 주세요.")
if create_new_campaign and campaign_structure == "CBO" and int(adset_count) != 1:
    ui_warnings.append("현재 CBO 생성 자동화는 1개 캠페인 / 1개 광고세트 기준입니다. CBO는 광고세트 1개로 실행해 주세요.")
if any(mode == "per_ad_auto" for mode in url_modes):
    unique_paths = {path for item in adsets for path in item.get("pathNumbers", [])}
    if len(unique_paths) > 1:
        ui_warnings.append("기존 엔진은 실행 1회당 Repurely path number 1개를 사용합니다. path가 여러 개면 첫 번째 path로 저장됩니다.")

first_adset = adsets[0]
ad_count_for_env = int(first_adset["adCount"])
first_path = str((first_adset.get("pathNumbers") or [env.get("LANDING_PATH_NUMBER", "100")])[0])
adset_count_for_env = int(adset_count)
if campaign_mode in {"IMAGE_ONLY", "VIDEO_ONLY"}:
    adset_count_for_env = max(0, int(adset_count) - 1)
elif campaign_mode in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"}:
    adset_count_for_env = 0

next_env: dict[str, str] = {
    "AD_ACCOUNT_ID": ad_account_id,
    "CAMPAIGN_NAME": campaign_name,
    "CAMPAIGN_MODE": campaign_mode,
    "DRY_RUN": str(dry_run).lower(),
    "ADSET_START_INDEX": "1",
    "ADSET_COUNT": str(adset_count_for_env),
    "ADSET_DAILY_BUDGET": daily_budget,
    "CDP_URL": cdp_url,
    "CHROME_PROFILE_DIR": chrome_profile_dir,
    "RESUME_FROM_AD_INDEX": str(resume_from_ad_index),
    "RESUME_FROM_AD_NAME": resume_from_ad_name,
    "SCHEDULE_TIME": schedule_time,
    "LANDING_PATH_NUMBER": first_path,
    "REPURELY_BASE_URL": repurely_base_url,
    "NAMING_ADSET_TEMPLATE": naming_adset_template,
    "NAMING_AD_TEMPLATE": naming_ad_template,
    "ENABLE_DESKTOP_ALERT": str(enable_desktop_alert).lower(),
    "NOTIFY_ON_SUCCESS": str(notify_on_success).lower(),
    "NOTIFY_ON_ERROR": str(notify_on_error).lower(),
    "NOTIFY_ON_STOP": str(notify_on_stop).lower(),
    "NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT": str(notify_on_video_upload_timeout).lower(),
    "NOTIFICATION_APP_NAME": env.get("NOTIFICATION_APP_NAME", NOTIFICATION_DEFAULTS["NOTIFICATION_APP_NAME"]),
    "NOTIFICATION_SUCCESS_TITLE": env.get("NOTIFICATION_SUCCESS_TITLE", NOTIFICATION_DEFAULTS["NOTIFICATION_SUCCESS_TITLE"]),
    "NOTIFICATION_ERROR_TITLE": env.get("NOTIFICATION_ERROR_TITLE", NOTIFICATION_DEFAULTS["NOTIFICATION_ERROR_TITLE"]),
    "NOTIFICATION_TIMEOUT_TITLE": env.get("NOTIFICATION_TIMEOUT_TITLE", NOTIFICATION_DEFAULTS["NOTIFICATION_TIMEOUT_TITLE"]),
    "WAIT_BASE_RETRY_COUNT": str(wait_base_retry_count),
    "WAIT_BASE_RETRY_INTERVAL_MS": str(wait_base_retry_interval),
    "WAIT_EXTENDED_RETRY_COUNT": str(wait_extended_retry_count),
    "WAIT_EXTENDED_RETRY_INTERVAL_MS": str(wait_extended_retry_interval),
    "VIDEO_UPLOAD_TIMEOUT_MS": str(video_upload_timeout_ms),
    "VIDEO_UPLOAD_FALLBACK_WAIT_MS": str(video_upload_fallback_wait_ms),
    "AUTO_RESUME_RECOVERABLE_ERRORS": str(auto_resume_recoverable_errors).lower(),
    "AUTO_RESUME_MAX_ATTEMPTS": str(auto_resume_max_attempts),
    "AUTO_RESUME_WAIT_MS": str(auto_resume_wait_ms),
    "MODE_01_WAIT_MS": str(mode_01_wait_ms),
    "MODE_02_WAIT_MS": str(mode_02_wait_ms),
    "MODE_03_WAIT_MS": str(mode_03_wait_ms),
    "MODE_04_WAIT_MS": str(mode_04_wait_ms),
    "MODE_BLOG_VIDEO_WAIT_MS": str(mode_blog_video_wait_ms),
}

next_env["AD_CREATIVE_COUNT"] = str(max(0, ad_count_for_env - 1))
next_env["CAMPAIGN_BUDGET"] = campaign_budget if campaign_structure == "CBO" else ""

if campaign_mode in {"BLOG_MIXED", "BLOG_VIDEO", "BLOG_VIDEO_DIRECT"}:
    next_env["BLOG_ASSET_ROOT"] = str(first_adset.get("videoFolder") or first_adset.get("imageFolder") or "")
    next_env["BLOG_ADSET_NAME_TEMPLATE"] = naming_adset_template
    next_env["DATE_FORMAT"] = "MMDD"
    next_env["BLOG_ASSET_MATCH_MODE"] = "exact"
    next_env["BLOG_IMAGE_AD_NAME_PREFIX"] = "f_i_b_o_l"
    next_env["BLOG_VIDEO_AD_NAME_PREFIX"] = "f_v_o_l" if campaign_mode == "BLOG_VIDEO_DIRECT" else "f_v_b_o_l"
    for item in adsets:
        next_env[f"BLOG_LANDING_URL_{item['index']}"] = str(item.get("sharedLandingUrl") or "")
        if item.get("folderOverride"):
            override_folder = str(item.get("videoFolder") or item.get("imageFolder") or "")
            next_env[f"BLOG_ADSET_{item['index']}_IMAGE_DIR"] = override_folder
            next_env[f"BLOG_ADSET_{item['index']}_VIDEO_DIR"] = override_folder
elif campaign_mode == "IMAGE_ONLY":
    next_env["IMAGE_ONLY_UPLOAD_MODE"] = "PER_AD"
    next_env["IMAGE_ONLY_ASSET_ROOT"] = str(first_adset.get("imageFolder") or "")
    next_env["MEDIA_FOLDER_PATH"] = str(first_adset.get("imageFolder") or "")
elif campaign_mode == "VIDEO_ONLY":
    next_env["VIDEO_ONLY_ASSET_ROOT"] = str(first_adset.get("videoFolder") or "")
elif campaign_mode in {"VIDEO_ONLY_CBO", "IMAGE_ONLY_CBO"}:
    mode_prefix = "VIDEO_ONLY_CBO" if campaign_mode == "VIDEO_ONLY_CBO" else "IMAGE_ONLY_CBO"
    folder_key = "VIDEO_ONLY_CBO_VIDEO_FOLDER" if campaign_mode == "VIDEO_ONLY_CBO" else "IMAGE_ONLY_CBO_IMAGE_FOLDER"
    next_env[folder_key] = str(first_adset.get("videoFolder") or first_adset.get("imageFolder") or "")
    next_env[f"{mode_prefix}_AUTO_LANDING_URL"] = "true"
    next_env[f"{mode_prefix}_ADSET_NAME_1"] = str(preview_rows[0]["adset_name"]) if preview_rows else ""
    for row_number, row in enumerate(preview_rows, start=1):
        next_env[f"{mode_prefix}_AD_NAME_{row_number}"] = str(row["ad_name"])

with st.expander("Derived automation mapping / preview", expanded=True):
    st.write(f"Derived internal mode: `{campaign_mode}`")
    if create_new_campaign:
        st.write(f"Campaign structure: `{campaign_structure}`")
        if campaign_structure == "CBO":
            st.write(f"Campaign budget: `{format_budget_preview(campaign_budget) or '(invalid)'}`")
    if ui_warnings:
        for warning in ui_warnings:
            st.warning(warning)
    if ui_errors:
        for error in ui_errors:
            st.error(error)
    st.dataframe(preview_rows, use_container_width=True)

st.divider()

col1, col2, col3 = st.columns(3)
with col1:
    if st.button("Save .env", type="primary"):
        saved = write_env(next_env)
        st.success(f"Saved: {ENV_PATH}")
        st.toast("알림 설정을 포함해 .env 저장 완료")
        st.code(saved, language="dotenv")

with col2:
    if st.button("Run dry-run"):
        dry_run_env = {**next_env, "DRY_RUN": "true"}
        errors = validate_form(dry_run_env) + ui_errors
        saved = write_env(dry_run_env)
        st.caption("Saved .env for dry-run")
        st.code(saved, language="dotenv")
        if errors:
            st.error("Fix these fields before dry-run:")
            st.toast("작업 중단: 입력값 검증 실패")
            for error in errors:
                st.write(f"- {error}")
        else:
            command = ["node", "src/open-campaign.js"]
            code, output = run_command(command, timeout=300)
            show_command_result("dry-run", command, code, output)
            if code == 0:
                st.toast("Meta 광고 자동화 dry-run 완료")
            else:
                st.toast("작업 중단: 자세한 내용은 로그를 확인하세요")

with col3:
    if st.button("Run real automation terminal", disabled=not IS_WINDOWS):
        real_env = {**next_env, "DRY_RUN": "false"}
        errors = validate_form(real_env) + ui_errors
        saved = write_env(real_env)
        st.caption("Saved .env for real run")
        st.code(saved, language="dotenv")
        if errors:
            st.error("Fix these fields before real run:")
            st.toast("작업 중단: 입력값 검증 실패")
            for error in errors:
                st.write(f"- {error}")
        else:
            try:
                run_env_path, run_env_content = write_run_env_snapshot(real_env, profile_slot)
                start_powershell(build_automation_command(run_env_path))
                st.warning("DRY_RUN=false saved. Automation terminal opened.")
                st.caption(f"Run env snapshot: {run_env_path}")
                with st.expander("Run env snapshot", expanded=False):
                    st.code(run_env_content, language="dotenv")
                st.toast("자동화 터미널을 열었습니다. 완료/에러 알림은 실제 실행 결과에 따라 표시됩니다")
            except Exception as exc:
                st.error(f"Automation terminal launcher is unavailable here: {exc}")
                st.info("Streamlit Cloud can preview settings, but real Meta automation must run on your local Windows PC.")

with st.expander("Current .env", expanded=False):
    if ENV_PATH.exists():
        st.code(ENV_PATH.read_text(encoding="utf-8"), language="dotenv")
    else:
        st.info(".env does not exist yet.")
