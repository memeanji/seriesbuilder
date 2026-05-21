from __future__ import annotations

import os
import platform
import subprocess
import base64
import json
from dataclasses import dataclass
from typing import Callable


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass
class NotificationConfig:
    enabled: bool
    app_name: str
    success_title: str
    error_title: str
    timeout_title: str
    notify_on_success: bool
    notify_on_error: bool
    notify_on_stop: bool
    notify_on_video_upload_timeout: bool


def get_config() -> NotificationConfig:
    return NotificationConfig(
        enabled=_bool_env("ENABLE_DESKTOP_ALERT", False),
        app_name=os.getenv("NOTIFICATION_APP_NAME", "Meta Ads Automation"),
        success_title=os.getenv("NOTIFICATION_SUCCESS_TITLE", "작업 완료"),
        error_title=os.getenv("NOTIFICATION_ERROR_TITLE", "작업 중단"),
        timeout_title=os.getenv("NOTIFICATION_TIMEOUT_TITLE", "업로드 지연"),
        notify_on_success=_bool_env("NOTIFY_ON_SUCCESS", True),
        notify_on_error=_bool_env("NOTIFY_ON_ERROR", True),
        notify_on_stop=_bool_env("NOTIFY_ON_STOP", True),
        notify_on_video_upload_timeout=_bool_env("NOTIFY_ON_VIDEO_UPLOAD_TIMEOUT", True),
    )


def _streamlit_fallback(kind: str, title: str, body: str) -> None:
    try:
        import streamlit as st

        if kind == "success":
            st.success(body)
        elif kind == "video_upload_timeout":
            st.warning(body)
        elif kind in {"error", "stop"}:
            st.error(body)
        else:
            st.info(body)
        st.toast(f"{title}: {body[:120]}")
    except Exception as exc:
        print(f"[NOTIFY] Streamlit fallback unavailable: {exc}")


def _desktop_notify(title: str, body: str, config: NotificationConfig) -> None:
    system = platform.system().lower()
    if system == "darwin":
        escaped_app = config.app_name.replace("\\", "\\\\").replace('"', '\\"')
        escaped_title = title.replace("\\", "\\\\").replace('"', '\\"')
        escaped_body = body.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.run(
            [
                "osascript",
                "-e",
                f'display notification "{escaped_body}" with title "{escaped_app}" subtitle "{escaped_title}"',
            ],
            check=True,
            timeout=5,
        )
    elif system == "windows":
        payload = base64.b64encode(json.dumps({"title": title, "message": body}).encode("utf-8")).decode("ascii")
        script = "\n".join(
            [
                f"$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}')) | ConvertFrom-Json",
                "$title = [string]$payload.title",
                "$message = [string]$payload.message",
                "try {",
                "  $wshell = New-Object -ComObject WScript.Shell;",
                "  $wshell.Popup($message, 8, $title, 64) | Out-Null;",
                "} catch {",
                "  Add-Type -AssemblyName PresentationFramework -ErrorAction Stop;",
                "  [System.Windows.MessageBox]::Show($message, $title) | Out-Null;",
                "}",
            ]
        )
        encoded_command = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded_command],
            check=True,
            timeout=12,
        )
    else:
        subprocess.run(["notify-send", title, body], check=True, timeout=5)


def notify_info(title: str, message: str) -> None:
    _notify("info", title, message)


def notify_success(message: str, detail: str | None = None) -> None:
    config = get_config()
    if config.notify_on_success:
        _notify("success", config.success_title, message, detail)


def notify_error(message: str, detail: str | None = None) -> None:
    config = get_config()
    if config.notify_on_error:
        _notify("error", config.error_title, message, detail)


def notify_stop(message: str, detail: str | None = None) -> None:
    config = get_config()
    if config.notify_on_stop:
        _notify("stop", config.error_title, message, detail)


def notify_video_upload_timeout(message: str, detail: str | None = None) -> None:
    config = get_config()
    if config.notify_on_video_upload_timeout:
        _notify("video_upload_timeout", config.timeout_title, message, detail)


def _notify(kind: str, title: str, message: str, detail: str | None = None) -> None:
    config = get_config()
    body = "\n".join(part.strip() for part in [message, detail or ""] if part and part.strip())
    if len(body) > 420:
        body = body[:417] + "..."

    try:
        if config.enabled:
            _desktop_notify(title, body, config)
        _streamlit_fallback(kind, title, body)
        print(f"[NOTIFY] {kind}: {title}: {body}")
    except Exception as exc:
        print(f"[NOTIFY] desktop notification failed: {exc}")
        try:
            _streamlit_fallback(kind, title, body)
        except Exception as fallback_exc:
            print(f"[NOTIFY] fallback failed: {fallback_exc}")
