"""pytools/parse.py —— 文档解析主力（TS 侧 route 的 L0-py / L1-py-vl 策略 spawn 本脚本）

选型：
  PDF            → PyMuPDF4LLM；逐页判定，文字层空/稀的页**自动升级 qwen-vl-ocr 重解析**（混合文档救活）
  DOCX           → markitdown（微软官方；手写 mammoth 在 TS 侧兜底）
  XLSX/XLS       → openpyxl  sheet 级：一 sheet 一原子块（行列关联不断）；台账型 sheet 拒收转 SQL
  PPTX/HTML      → markitdown 在则用；不在则标准库直抽（slide XML / html.parser）——不依赖第三方
  ODF(odt/ods/odp) → zip 内 content.xml 直抽（标准库）
  RTF            → 控制字剥离（标准库）
  PNG/JPG/...    → qwen-vl-ocr 整页解析（非 PNG/JPG 先转 PNG）
  TXT/MD/CSV/... → 直读（md 语法顺带被 md_to_blocks 吃下；csv/tsv 转管道表）
  其他后缀       → **内容嗅探兜底**：字节像文本就按文本收；否则 reject 并说明（不静默）

依赖：pip install -r requirements.txt；VL 路要环境变量 DASHSCOPE_API_KEY（Bun 自动读 .env 并透传）
契约：stdout 最后一行 = {"blocks": [...], "reject": null|"...", "diag": {...}}；日志走 stderr；非零码=失败
      diag 的字段与 TS 侧 src/rag/inspect/profile.ts 的 ParseDiag **逐字同名**（见 contracts/doc-profile.schema.json）
      纪律：diag 只记事实，不做判断（判死在 TS 侧 gate/quality.ts，一处就够）
"""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
LEDGER_HINTS = {"试剂名称", "规格", "数量", "存放位置", "单价", "批号", "cas", "有效期", "供应商"}
SHEET_ROW_CAP = 500    # 巨表保险丝：超了截断并标注（真发生说明该走 SQL）
MIN_PAGE_CHARS = 20    # 页文字层低于这个数 → 视为扫描页，升 VL
VL_PAGE_CAP = int(os.environ.get("VL_PAGE_CAP", "60"))   # 单次解析 VL 页数上限（成本闸；env 可调）

# ── 图转文（占位→并发描述→回填→再分块）的护栏 ──
MEDIA: Path = Path("./_parse_media")           # main() 里被 --media-dir 覆写
IMG_MIN_BYTES = 5 * 1024                        # <5KB 视为装饰线/页眉小图，直接丢引用
CAPTION_CAP = 20                                # 每文档最多描述几张图（成本闸）
# ⚠️ 预算必须是"每文档"而不是"每次调用"：PDF 是**逐页**调 caption_md 的，
#    若像原来那样每页都 `uniq[:CAPTION_CAP]`（预算每页重置），一份 300 页的 PDF 最多能发起 300×20 次 VL 调用 ——
#    成本闸在最重的格式上等于不存在。用可变容器让预算跨页累计
#    （parse.py 一次只处理一个文件，进程级 == 文档级）。
_IMG_BUDGET: dict[str, int] = {"left": CAPTION_CAP}

# 图转文标记：**必须在写入侧打标，事后无法追认**。
# 正文里出现它 = 这段是视觉模型转录的，不是文档原文。没有标记的话，下游（切块/检索/回答）
# 分不出"原文"和"模型看图的转述"，而扫描件/整页截图全靠这条路 —— 用户会把模型的话当文献原文引用。
TAG_PAGE_TRANSCRIBED = "**【图片转写·非文档原文】**"
TAG_CAPTION = "图片转写："
PAGE_LIKE_BYTES = 100 * 1024                    # ≥100KB 的图按"整页"转录（描述 prompt 会把整页压成两行）
MD_IMG_RE = re.compile(r"!\[([^\]\n]*)\]\(([^)\s]+)\)")
DATA_URI_RE = re.compile(r"!\[([^\]\n]*)\]\(data:image/([a-zA-Z+]+);base64,([A-Za-z0-9+/=]+)\)")

# ══════════════════════════════════════════════════════════════════════════
# diag：抽取侧的记账本（解析泛化第一刀）
# 为什么是模块级可变字典：本脚本是"一次 spawn 解一份文件"的一次性进程，PARSERS 表要维持
# `lambda p: (blocks, reject)` 的统一签名（跨语言一致性断言只认那个表），所以诊断走旁路累计，
# 不走函数签名。任何"发生了降级"的地方都必须在这里留一个数或一句人话，否则 TS 侧永远看不见。
# ══════════════════════════════════════════════════════════════════════════
DIAG: dict = {"extractor": "none", "chars": 0}


def _inc(key: str, n: int = 1) -> None:
    DIAG[key] = int(DIAG.get(key, 0)) + n


def _note(msg: str) -> None:
    DIAG.setdefault("notes", [])
    if len(DIAG["notes"]) < 50:      # 上限防病态文件把台账撑爆
        DIAG["notes"].append(msg)


def _finish_diag(blocks: list[dict], extractor: str) -> list[dict]:
    """收尾：记抽取器与正文字符数。chars 与 TS 侧 gate 的分子**同口径**（非 image 块的 markdown 以 \\n 相接）"""
    DIAG["extractor"] = extractor
    DIAG["chars"] = len("\n".join(b.get("markdown", "") for b in blocks if b.get("type") != "image"))
    return blocks


# ══════════════════════════════════════════════════════════════════════════
# 文本读取与嗅探：编码猜错=整篇乱码，所以这里必须把 BOM/GBK 都吃下
# ══════════════════════════════════════════════════════════════════════════
_TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5")
# 注：cp1252 已从常规候选里移除（单独作为最后兜底）。原因：它对**任意字节**都能解码出"看似干净"的
# 拉丁字母，混在候选里参与评分会把中文文件抢走（分数反而比正确编码更低）。


def _suspicion(text: str) -> float:
    """错解编码的可疑度：替换符 / 不该出现的控制符 / 私用区字符 的占比。
    用于在多个"都能解码"的编码之间挑最优，也用于把"疑似误判"记进台账（绝不静默）。"""
    if not text:
        return 0.0
    bad = 0
    for ch in text:
        o = ord(ch)
        if ch == "\ufffd" or (o < 0x20 and ch not in "\t\n\r\f\v") or 0xE000 <= o <= 0xF8FF or 0xFFF0 <= o <= 0xFFFF:
            bad += 1
    return bad / len(text)


def read_text(path: Path) -> str:
    """BOM → 多编码试解 → **按可疑度挑最优**；都不干净时用最优的那个并明确记账。
    为什么不"谁先不抛谁赢"：GB18030 的双字节空间几乎覆盖全部双字节序列，
    Big5 的字节流通常能被它"无异常解码"成乱码 —— 于是 big5 分支永远走不到，整篇乱码还无人知道。
    全失败时退回 utf-8 + replace（保留 ASCII 骨架，比拉丁乱码有用）。"""
    raw = path.read_bytes()
    # ⚠️ UTF-32 的 BOM 前两字节与 UTF-16 相同，必须先判它（顺序错了整篇会解成乱码）
    if raw[:4] in (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff"):
        return raw.decode("utf-32", errors="replace")
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")

    best: tuple[str, str, float] | None = None  # (text, enc, suspicion)
    for enc in _TEXT_ENCODINGS:
        try:
            text = raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        score = _suspicion(text)
        if score <= 0.001:
            if enc not in ("utf-8-sig", "utf-8"):
                _note(f"文本按 {enc} 解码（非 UTF-8）")
            return text
        if best is None or score < best[2]:
            best = (text, enc, score)
    if best is not None:
        _note(f"文本按 {best[1]} 解码，但可疑度偏高（{best[2]:.1%}）—— 可能是编码误判，建议人工核对原文")
        _inc("text_encoding_suspect")
        return best[0]
    _note("文本编码无法确认，按 utf-8 + replace 兜底（可能有替换符）")
    _inc("text_encoding_fallback")
    return raw.decode("utf-8", errors="replace")


def looks_like_text(path: Path) -> bool:
    """内容嗅探：头部 4KB 像不像可解码文本（陌生后缀的兜底判据，与 TS 侧 probe.looksLikeText 同口径）"""
    try:
        head = path.read_bytes()[:4096]
    except OSError:
        return False
    if not head:
        return False
    if head[:2] in (b"\xff\xfe", b"\xfe\xff") or head[:4] in (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff"):
        return True
    bad = head.count(b"\x00") * 2
    decoded = head.decode("utf-8", errors="replace")
    for ch in decoded:
        c = ord(ch)
        if c == 0xFFFD:
            bad += 1
        elif c < 0x20 and c not in (9, 10, 13, 12, 11):
            bad += 1
    return bool(decoded) and bad / len(decoded) <= 0.02


def md_to_blocks(md: str, page: int | None = None) -> list[dict]:
    """markdown → Block[]：标题/表格整块/图片引用/段落

    9/16 保行结构（切片泛化的前提）：改前把"连续非空行"用空格拼成一段 ——
      行结构在**块化阶段就被扔掉**，切块层拿到的是一坨糊状文本，只能靠长度硬切；
      ICSC 那种"一行 naive 列拼接、下一行同内容带全角｜"的重复结构也因此被压进同一段。
      现在：空行才是段落边界，段内**保留换行**（行 = 版式边界，切块层要用它）。
    """
    blocks: list[dict] = []
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        h = HEADING_RE.match(s)
        if h:
            blocks.append({"type": "heading", "level": len(h.group(1)), "markdown": h.group(2).strip(), "page": page})
            i += 1
            continue
        if s.startswith("|"):
            buf: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                buf.append(lines[i].strip())
                i += 1
            blocks.append({"type": "table", "markdown": "\n".join(buf), "page": page})
            continue
        if s.startswith("![") or s.startswith("<img"):
            blocks.append({"type": "image", "markdown": s, "page": page})
            i += 1
            continue
        # 段落：吃到空行为止；段内换行原样保留（不 join、不丢结构）
        para: list[str] = []
        while i < len(lines):
            t = lines[i]
            if not t.strip() or t.strip().startswith("#") or t.strip().startswith("|") or t.strip().startswith("!["):
                break
            para.append(t.rstrip())
            i += 1
        # 段首段尾空行去掉，段内不动
        while para and not para[0].strip():
            para.pop(0)
        while para and not para[-1].strip():
            para.pop()
        if para:
            blocks.append({"type": "text", "markdown": "\n".join(para), "page": page})
    return blocks


# ─────────────────────────────────────────── qwen-vl-ocr 通道
FENCE_RE = re.compile(r"^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$")


def strip_fences(md: str) -> str:
    """qwen-vl 常把'只输出markdown'执行成包一层 ```markdown 围栏——剥掉，防脏块入库"""
    t = md.strip()
    m = FENCE_RE.match(t)
    return m.group(1).strip() if m else t


VL_PROMPT = (
    "提取本页全部文档内容，输出 markdown。要求："
    "1) 忠实转录，不总结、不改写、不遗漏任何文字；"
    "2) 表格：简单表输出 |md| 管道表，含合并单元格输出 <table> HTML，绝不允许拉平成段落；"
    "3) 标题层级用 # 表达；"
    "4) 只输出 markdown 本身，不要任何解释。"
)

CAPTION_PROMPT = (
    "描述这张文档插图：先给类型（GHS危险象形图/化学品标签/装置图/流程图/组织结构/照片/其他），"
    "再给关键信息；图中的文字要逐字转录。一两句中文，单行输出，只输出描述本身。"
)


def _openai_client():
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        raise RuntimeError("缺 DASHSCOPE_API_KEY，VL 路不可用")
    from openai import OpenAI
    return OpenAI(api_key=key, base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")


def vl_image(png: bytes) -> str:
    """一页 PNG → markdown。没 key 就抛（TS 侧凭非零码走容灾/隔离，绝不静默）"""
    client = _openai_client()
    res = client.chat.completions.create(
        model=os.environ.get("VL_MODEL", "qwen-vl-ocr-latest"),
        temperature=0.01,
        max_tokens=4096,
        messages=[{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
            {"type": "text", "text": VL_PROMPT},
        ]}],
    )
    return strip_fences(res.choices[0].message.content or "")


def vl_caption(png: bytes) -> str:
    """一张插图 → 一行描述（图转文用；与 vl_image 同通道不同任务）"""
    client = _openai_client()
    res = client.chat.completions.create(
        model=os.environ.get("VL_MODEL", "qwen-vl-ocr-latest"),
        temperature=0.01,
        max_tokens=300,
        messages=[{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
            {"type": "text", "text": CAPTION_PROMPT},
        ]}],
    )
    one_line = res.choices[0].message.content or "图片"
    return re.sub(r"\s+", " ", one_line).strip()[:160]  # 压成单行，防炸 md 段落判定


# hash → 描述 缓存：同一张 logo/水印跨页重复时只花一分钱（进程级）；值 = (kind, text)
_caption_cache: dict[str, tuple[str, str]] = {}


def _caption_one(path: Path) -> tuple[str, str]:
    """一张盘上图片 → (kind, text)：
         none    = 装饰小图（删掉引用）
         caption = 一句描述（进 alt 文本）
         page    = 大图整页转录（**替换整条引用**为转写出的 markdown，绝不能塞进 alt —— 多行 md 会撑破图片语法）
       ⚠️ 大图（≥PAGE_LIKE_BYTES）判为"正文可能在图里"：caption 的 160 字上限会把整页压成两行（旧代码对此零告警）。"""
    try:
        raw = path.read_bytes()
    except OSError:
        _inc("captions_failed")
        return "caption", "图片(读取失败)"
    if len(raw) < IMG_MIN_BYTES:
        _inc("images_dropped_small")  # 小图按装饰图丢弃是有意规则，但"丢了几张"必须能查到（不静默）
        return "none", ""
    digest = hashlib.md5(raw).hexdigest()
    if digest in _caption_cache:
        return _caption_cache[digest]
    try:
        if len(raw) >= PAGE_LIKE_BYTES:
            text = vl_image(_to_png(path))
            _note(f"大图 {path.name}（{len(raw) // 1024}KB）按整页转录而非一句描述")
            kind = "page"
        else:
            text = vl_caption(raw)
            if len(text) >= 160:
                _inc("captions_truncated")
            kind = "caption"
    except Exception as e:
        print(f"[parse.py] caption 失败 {path.name}: {e}", file=sys.stderr)
        _inc("captions_failed")
        return "caption", "图片(描述失败)"
    _caption_cache[digest] = (kind, text)
    return kind, text


def caption_md(md: str) -> str:
    """图转文主流程：内联dataURI落盘 → 收集引用 → 并发VL描述 → 回填alt文本（位置不动，随后分块）"""
    MEDIA.mkdir(parents=True, exist_ok=True)

    # ① markitdown 常把小图塞成 data:image base64 URI —— 先落盘换成文件引用（库外统一按路径处理）
    def _dump_uri(m: re.Match) -> str:
        alt, ext, b64 = m.group(1), (m.group(2) or "png").replace("+xml", ""), m.group(3)
        try:
            blob = base64.b64decode(b64)
        except Exception:
            # 坏 base64 的引用只能丢，但**必须记账**：静默丢内容 = 这份文档少了一张图而无人知道
            _inc("images_dropped_bad_uri")
            _note("有内联图片 base64 解码失败，其引用已删除（这部分内容缺失）")
            return ""
        fname = MEDIA / f"emb-{hashlib.md5(blob).hexdigest()[:10]}.{ext}"
        if not fname.exists():
            fname.write_bytes(blob)
        return f"![{alt}]({fname})"
    md = DATA_URI_RE.sub(_dump_uri, md)

    # ② 收集去重后的图片引用
    refs = [m.group(2) for m in MD_IMG_RE.finditer(md)
            if not m.group(2).startswith(("http", "data:"))]
    uniq: list[str] = []
    for r in refs:
        if r not in uniq:
            uniq.append(r)
    if not uniq:
        return md
    _inc("images_total", len(uniq))
    budget = max(0, _IMG_BUDGET["left"])   # 跨页累计（见 _IMG_BUDGET 注释）
    todo = uniq[:budget]
    _IMG_BUDGET["left"] -= len(todo)
    if len(uniq) > len(todo):
        _inc("images_over_cap", len(uniq) - len(todo))
        print(f"[parse.py] 图片 {len(uniq)} 张超本档剩余预算（{budget} 张），只描述前 {len(todo)} 张", file=sys.stderr)
        _note(f"图片 {len(uniq)} 张超本档预算（每文档 {CAPTION_CAP} 张），{len(uniq) - len(todo)} 张仅有原始引用")

    # ③ 并发描述（ThreadPool：VL 调用是网络 IO，4 路足够吃满配额前不惹眼）
    with ThreadPoolExecutor(max_workers=4) as pool:
        descs = list(pool.map(lambda p: _caption_one(Path(p)), todo))

    # ④ 回填：描述进 alt，位置原样保留；装饰小图（kind=none）整条引用抹掉；大图整页转录替换引用
    lookup = dict(zip(todo, descs))
    _inc("images_captioned", sum(1 for k, _ in descs if k != "none"))
    def _backfill(m: re.Match) -> str:
        alt, target = m.group(1), m.group(2)
        if target in lookup:
            kind, text = lookup[target]
            if kind == "none":
                return ""
            if kind == "page":
                # 整页转写：独立成块。**必须带标记** —— 这段文字是视觉模型写的，不是文档原文；
                # 不带标记下游就分不出"原文"与"模型转述"，扫描件/整页截图全靠这条路，
                # 用户会把模型的话当成文献原文引用（溯源链条在这里断掉）。
                return f"\n{TAG_PAGE_TRANSCRIBED}\n\n{text}\n"
            return f"![{TAG_CAPTION}{text or alt}]({target})"
        return m.group(0)  # 超上限没描述的：原引用带着走
    return MD_IMG_RE.sub(_backfill, md)


def _to_png(path: Path) -> bytes:
    """任意图片 → PNG 字节。优先 PyMuPDF（已在依赖里、无额外安装），退 Pillow；都失败则交原字节"""
    if path.suffix.lower() in (".png", ".jpg", ".jpeg"):
        return path.read_bytes()
    try:
        import pymupdf
        doc = pymupdf.open(str(path))
        if doc.page_count:
            return doc[0].get_pixmap().tobytes("png")
    except Exception as e:
        _note(f"{path.suffix} 转 PNG：PyMuPDF 不可用（{str(e)[:60]}）")
    try:
        import io
        from PIL import Image
        with Image.open(path) as im:
            buf = io.BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            return buf.getvalue()
    except Exception as e:
        _note(f"{path.suffix} 转 PNG：Pillow 也失败（{str(e)[:60]}），按原字节送 VL")
    return path.read_bytes()


# ─────────────────────────────────────────── 各格式
def parse_pdf(path: Path) -> list[dict]:
    import pymupdf  # PyMuPDF（pymupdf4llm 的底座）
    import pymupdf4llm
    chunks = pymupdf4llm.to_markdown(str(path), page_chunks=True, write_images=True,
                                     image_path=str(MEDIA), image_format="png") or []
    doc = pymupdf.open(str(path))
    zoom = 150 / 72  # ~150dpi：VL 吃这个分辨率足够，再大白烧 token
    vl_attempts = 0   # ⚠️ 计"尝试"而非"成功"：失败的调用照样花时间与请求配额，300 页坏扫描件不能打 300 次
    blocks: list[dict] = []
    DIAG["pages_total"] = doc.page_count
    for pno in range(1, doc.page_count + 1):
        ch = chunks[pno - 1] if pno <= len(chunks) else {}
        text = (ch.get("text", "") if isinstance(ch, dict) else str(ch)).strip()
        if len(text) < MIN_PAGE_CHARS:  # 扫描页/乱码页 → 升 VL
            if vl_attempts >= VL_PAGE_CAP:
                # ⚠️ 旧代码这里 `continue`：整页内容人间蒸发，且只写 stderr、进不了台账。
                #    现在：把文字层里那点残留留下（有总比没有强），并把"跳过"记成明账。
                _inc("pages_skipped_by_cap")
                _note(f"p{pno} 超 VL 页数上限({VL_PAGE_CAP})：保留文字层残留 {len(text)} 字，未升 VL"
                      + ("（可用 VL_PAGE_CAP 调高上限）" if vl_attempts == VL_PAGE_CAP else ""))
            else:
                pix = doc[pno - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
                vl_attempts += 1
                try:
                    text = vl_image(pix.tobytes("png"))
                    _inc("pages_via_vl")
                    print(f"[parse.py] p{pno} 走 VL 路", file=sys.stderr)
                except Exception as e:
                    print(f"[parse.py] p{pno} VL 失败: {e}", file=sys.stderr)
                    _inc("pages_vl_failed")
                    _note(f"p{pno} VL 失败（{str(e)[:60]}）")
                    text = ""
        if not text:
            _inc("pages_empty")
        blocks.extend(md_to_blocks(caption_md(text), pno))  # 页内插图先图转文，再进块化
    return _finish_diag(blocks, "pymupdf4llm+vl" if vl_attempts else "pymupdf4llm")


def _restore_docx_media(path: Path, md: str) -> str:
    """markitdown 故意把 docx 图片吐成 `![](data:image/......)` 占位——真字节在 zip 的 word/media 里。
    按 document.xml 的 r:embed 引用顺序抠出落盘，逐个换回占位（位置不动），再进图转文管线。"""
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            saved: list[Path] = []
            try:
                xml = z.read('word/document.xml').decode('utf-8', 'ignore')
                rels = z.read('word/_rels/document.xml.rels').decode('utf-8', 'ignore')
                rid2tgt = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(media/[^"]+)"', rels))
                ordered = [rid2tgt[r] for r in re.findall(r'r:embed="(rId\d+)"', xml) if r in rid2tgt]
            except KeyError:
                ordered = []
            if not ordered:  # 拿不到引用序就按文件名序兜底
                ordered = sorted(n.split('word/')[-1] for n in names if n.startswith('word/media/'))
            MEDIA.mkdir(parents=True, exist_ok=True)
            for tgt in ordered:
                full = f'word/{tgt}'
                if full not in names:
                    continue
                dest = MEDIA / Path(tgt).name
                dest.write_bytes(z.read(full))
                saved.append(dest)
    except Exception as e:
        print(f"[parse.py] docx 媒体抠图失败: {e}", file=sys.stderr)
        # 只打 stderr 不够：进台账的是 stdout 的 diag，stderr 只留在控制台日志里
        _inc("docx_media_failed")
        _note(f"docx 抠图失败（{str(e)[:60]}）：图片仍是 data:image 占位，这部分图未转文")
        return md
    it = iter(saved)
    def _rep(m: re.Match) -> str:
        p = next(it, None)
        return m.group(0) if p is None else f"![{m.group(1)}]({p})"
    return re.sub(r'!\[([^\]\n]*)\]\(data:[^)]*\)', _rep, md)


def _markitdown_md(path: Path) -> str | None:
    """markitdown 转 markdown；装不上/不认这个格式都返回 None（由调用方落标准库实现）
    ⚠️ 实测坑（9/16）：markitdown 对**没有专用转换器**的格式会"原样当纯文本吐出"——
       RTF 就是（吐回来的还是 `{\\rtf1\\ansi...`）。那不是转换，是把控制字灌进向量库，
       所以产出必须过一遍体检：像没转过的原样文本 → 判失败，落标准库实现。"""
    try:
        from markitdown import MarkItDown
        res = MarkItDown().convert(str(path))
        text = getattr(res, "markdown", None) or getattr(res, "text_content", "") or ""
    except Exception as e:
        _note(f"markitdown 不可用或失败（{str(e)[:60]}）→ 落标准库实现")
        return None
    if not text.strip():
        _note(f"markitdown 对 {path.suffix} 产出为空，落标准库实现")
        return None
    head = text.lstrip()[:300]
    unconverted = (
        re.search(r"\{\\rtf1|\\fonttbl|\\ansi\b", head)          # RTF 控制字原样吐回
        or head[:40].lower().startswith(("<html", "<!doctype html"))  # HTML 原样吐回
    )
    if unconverted:
        _note(f"markitdown 未真正转换 {path.suffix}（产出仍是原始标记）→ 落标准库实现")
        return None
    return text


def parse_office(path: Path) -> list[dict]:
    """docx：markitdown 主力（图转文同路：描述回填后才是分块的原料）"""
    from markitdown import MarkItDown
    res = MarkItDown().convert(str(path))
    text = getattr(res, "markdown", None) or getattr(res, "text_content", "") or ""
    if path.suffix.lower() == '.docx':
        text = _restore_docx_media(path, text)
    return _finish_diag(md_to_blocks(caption_md(text)), "markitdown")


# ── HTML（标准库 html.parser：不装 markitdown 也能抽，标题/表格/列表都保住） ──
class _HtmlBlocks:
    """极简 HTML → Block[]。只认结构标签；脚本/样式整段丢弃（否则 CSS 会灌进向量库）"""
    SKIP = {"script", "style", "noscript", "head", "svg"}
    HEAD = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

    def __init__(self) -> None:
        from html.parser import HTMLParser

        outer = self

        class P(HTMLParser):
            def __init__(self) -> None:
                super().__init__(convert_charrefs=True)
                self.stack: list[str] = []
                self.buf: list[str] = []
                self.out: list[dict] = []
                self.table: list[list[str]] | None = None
                self.row: list[str] | None = None
                self.cell: list[str] | None = None

            def _flush(self, kind: str = "text", level: int | None = None) -> None:
                txt = re.sub(r"\s+", " ", "".join(self.buf)).strip()
                self.buf = []
                if txt:
                    b: dict = {"type": kind, "markdown": txt}
                    if level:
                        b["level"] = level
                    self.out.append(b)

            def handle_starttag(self, tag: str, attrs) -> None:
                self.stack.append(tag)
                if tag in outer.SKIP:
                    return
                if tag in outer.HEAD:
                    self._flush()
                elif tag == "table":
                    self._flush()
                    self.table = []
                elif tag == "tr" and self.table is not None:
                    self.row = []
                elif tag in ("td", "th") and self.row is not None:
                    self.cell = []
                elif tag in ("p", "div", "section", "article", "li", "br", "hr"):
                    self._flush()

            def handle_endtag(self, tag: str) -> None:
                if self.stack and tag in self.stack:
                    while self.stack and self.stack.pop() != tag:
                        pass
                if tag in outer.SKIP:
                    return
                if tag in outer.HEAD:
                    self._flush("heading", outer.HEAD[tag])
                elif tag in ("td", "th") and self.cell is not None and self.row is not None:
                    self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
                    self.cell = None
                elif tag == "tr" and self.row is not None and self.table is not None:
                    if any(c for c in self.row):
                        self.table.append(self.row)
                    self.row = None
                elif tag == "table" and self.table is not None:
                    outer._emit_table(self.table, self.out)
                    self.table = None
                    self.row = None
                elif tag in ("p", "div", "section", "article", "li"):
                    self._flush()

            def handle_data(self, data: str) -> None:
                if any(t in outer.SKIP for t in self.stack):
                    return
                if self.cell is not None:
                    self.cell.append(data)
                else:
                    self.buf.append(data)

        self.parser = P()

    @staticmethod
    def _emit_table(rows: list[list[str]], out: list[dict]) -> None:
        rows = [r for r in rows if r]
        if len(rows) < 2:
            for r in rows:
                out.append({"type": "text", "markdown": " ".join(r)})
            return
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        md = "\n".join(["| " + " | ".join(rows[0]) + " |",
                        "|" + "---|" * width,
                        *["| " + " | ".join(r) + " |" for r in rows[1:]]])
        out.append({"type": "table", "markdown": md})

    def feed(self, html: str) -> list[dict]:
        self.parser.feed(html)
        self.parser._flush()
        return self.parser.out


def parse_html(path: Path) -> list[dict]:
    md = _markitdown_md(path)
    if md is not None:
        return _finish_diag(md_to_blocks(caption_md(md)), "markitdown")
    blocks = _HtmlBlocks().feed(read_text(path))
    return _finish_diag(blocks, "html-parser")


# ── PPTX（标准库：zip 内 ppt/slides/slideN.xml 逐页抽 <a:t>；标题占位符 → heading） ──
def parse_pptx_stdlib(path: Path) -> list[dict]:
    import zipfile
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        slides = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                        key=lambda n: int(re.search(r"(\d+)", n.split("/")[-1]).group(1)))
        blocks: list[dict] = []
        for pno, name in enumerate(slides, 1):
            xml = z.read(name).decode("utf-8", "ignore")
            title = ""
            body: list[str] = []
            for sp in re.findall(r"<p:sp>[\s\S]*?</p:sp>", xml):
                ph = re.search(r'<p:ph[^>]*type="([^"]+)"', sp)
                is_title = bool(ph and ph.group(1) in ("title", "ctrTitle"))
                for para in re.findall(r"<a:p>([\s\S]*?)</a:p>", sp):
                    txt = "".join(re.findall(r"<a:t>([\s\S]*?)</a:t>", para))
                    txt = re.sub(r"\s+", " ", _unescape(txt)).strip()
                    if not txt:
                        continue
                    if is_title and not title:
                        title = txt
                    else:
                        body.append(txt)
            if title:
                blocks.append({"type": "heading", "level": 1, "markdown": f"第{pno}页 {title}", "page": pno})
            elif body:
                blocks.append({"type": "heading", "level": 2, "markdown": f"第{pno}页", "page": pno})
            for t in body:
                blocks.append({"type": "text", "markdown": t, "page": pno})
        if not slides:
            _note("pptx 内未找到 ppt/slides/*.xml（结构异常）")
    return blocks


def _unescape(s: str) -> str:
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def parse_pptx(path: Path) -> list[dict]:
    md = _markitdown_md(path)
    if md is not None:
        return _finish_diag(md_to_blocks(caption_md(md)), "markitdown")
    return _finish_diag(parse_pptx_stdlib(path), "pptx-xml")


# ── ODF（odt/ods/odp）：zip 内 content.xml 直抽 ──
def parse_odf(path: Path) -> list[dict]:
    import zipfile
    from xml.etree import ElementTree as ET

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    with zipfile.ZipFile(path) as z:
        xml = z.read("content.xml")
    root = ET.fromstring(xml)
    blocks: list[dict] = []
    tables_seen = 0

    def text_of(el) -> str:
        return re.sub(r"\s+", " ", "".join(el.itertext())).strip()

    def walk(el) -> None:
        nonlocal tables_seen
        for child in el:
            t = local(child.tag)
            if t == "h":
                lvl = child.attrib.get("{urn:oasis:names:tc:opendocument:xmlns:text:1.0}outline-level", "1")
                txt = text_of(child)
                if txt:
                    blocks.append({"type": "heading", "level": max(1, min(6, int(lvl) if lvl.isdigit() else 1)), "markdown": txt})
            elif t == "p":
                txt = text_of(child)
                if txt:
                    blocks.append({"type": "text", "markdown": txt})
            elif t == "table":
                rows: list[list[str]] = []
                for tr in child:
                    if local(tr.tag) != "table-row":
                        continue
                    row: list[str] = []
                    for tc in tr:
                        if local(tc.tag) not in ("table-cell", "covered-table-cell"):
                            continue
                        rep = tc.attrib.get("{urn:oasis:names:tc:opendocument:xmlns:table:1.0}number-columns-repeated", "1")
                        n = int(rep) if rep.isdigit() and int(rep) <= 50 else 1
                        row.extend([text_of(tc)] * n)
                    if any(c for c in row):
                        rows.append(row)
                if rows:
                    tables_seen += 1
                    _HtmlBlocks._emit_table(rows, blocks)
            elif t in ("section", "list", "list-item", "body", "text", "spreadsheet", "presentation", "frame", "note"):
                walk(child)

    body = next((e for e in root.iter() if local(e.tag) == "body"), root)
    walk(body)
    if tables_seen:
        _inc("sheets_total", tables_seen)
    return _finish_diag(blocks, "odf-xml")


# ── RTF：控制字剥离（扫描栈处理嵌套组；fonttbl/colortbl/pict 之类整组丢弃） ──
RTF_SKIP_DESTS = {
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "datastore",
    "latentstyles", "listtable", "listoverridetable", "rsidtbl", "generator", "filetbl",
    "header", "footer", "headerl", "headerr", "footerl", "footerr", "footnote", "xmlnstbl",
}


def rtf_to_text(raw: bytes) -> str:
    src = raw.decode("latin1")  # RTF 是 7-bit 骨架 + \\'hh 转义字节，先按 latin1 保字节
    out: list[str] = []
    i, n = 0, len(src)
    depth = 0
    skip_until: list[int] = []   # 每个被丢弃组的起始深度

    def skipping() -> bool:
        return bool(skip_until)

    while i < n:
        ch = src[i]
        if ch == "\\":
            m = re.match(r"\\([a-zA-Z]+)(-?\d+)?[ ]?", src[i:])
            if m:
                word, arg = m.group(1), m.group(2)
                i += m.end()
                if word in ("par", "line", "sect", "page", "row"):
                    if not skipping():
                        out.append("\n")
                elif word == "tab":
                    if not skipping():
                        out.append("\t")
                elif word == "u" and arg is not None:
                    if not skipping():
                        try:
                            cp = int(arg)
                            out.append(chr(cp + 65536 if cp < 0 else cp))
                        except ValueError:
                            pass
                    if i < n and src[i] == "?":  # \uN? 的 ANSI 回退字符
                        i += 1
                elif word == "bin" and arg is not None:
                    i += max(0, int(arg))
                continue
            m = re.match(r"\\'([0-9a-fA-F]{2})", src[i:])
            if m:
                if not skipping():
                    out.append(bytes([int(m.group(1), 16)]).decode("cp1252", errors="replace"))
                i += m.end()
                continue
            i += 2  # 转义符号本身（\{ \} \\ 等）
            continue
        if ch == "{":
            depth += 1
            i += 1
            m = re.match(r"\{\\\*?\\?([a-zA-Z]+)", src[i - 1:])
            if m and m.group(1).lower() in RTF_SKIP_DESTS:
                skip_until.append(depth)
            continue
        if ch == "}":
            if skip_until and skip_until[-1] == depth:
                skip_until.pop()
            depth -= 1
            i += 1
            continue
        if not skipping():
            out.append(ch)
        i += 1
    text = "".join(out)
    text = text.replace("\r", "\n")
    return text


def parse_rtf(path: Path) -> list[dict]:
    md = _markitdown_md(path)
    if md is not None:
        return _finish_diag(md_to_blocks(caption_md(md)), "markitdown")
    text = rtf_to_text(path.read_bytes())
    return _finish_diag(md_to_blocks(text), "rtf-strip")


def parse_image(path: Path) -> list[dict]:
    blocks = md_to_blocks(vl_image(_to_png(path)))
    return _finish_diag(blocks, "image-vl")


def parse_text(path: Path) -> list[dict]:
    return _finish_diag(md_to_blocks(read_text(path)), "text")


def parse_csv(path: Path) -> list[dict]:
    """csv/tsv → 一块管道表（既往当纯文本灌进正文：列关系全丢，检索命中一行也答不出列名）"""
    import csv as _csv
    text = read_text(path)
    sample = text[:8192]
    try:
        dialect = _csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except Exception:
        dialect = _csv.excel_tab if path.suffix.lower() == ".tsv" else _csv.excel
    # ⚠️ 与 xlsx 同病：先把所有行物化再切片 = 把保险丝装在内存之后。这里改成**读取时就停**。
    # （text 本身仍需整读为字符串：编码探测要先拿到全部字节；但行列表不再无界增长。）
    rows: list[list[str]] = []
    over_cap = False
    for r in _csv.reader(text.splitlines(), dialect):
        if not any(c.strip() for c in r):
            continue
        if len(rows) >= SHEET_ROW_CAP:
            over_cap = True
            break
        rows.append(r)
    if not rows:
        _note("csv 无有效行")
        return _finish_diag([], "csv-table")
    note = ""
    if over_cap:
        note = f"\n（超 {SHEET_ROW_CAP} 行已截断：这类大表请导入 MySQL 走 SQL 查询）"
        _note(f"csv 超 {SHEET_ROW_CAP} 行上限，已截断")
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    md = "\n".join(["| " + " | ".join(c.replace("|", "\\|") for c in rows[0]) + " |",
                    "|" + "---|" * width,
                    *["| " + " | ".join(c.replace("|", "\\|") for c in r) + " |" for r in rows[1:]]]) + note
    return _finish_diag([{"type": "table", "markdown": md}], "csv-table")


def parse_unknown(path: Path) -> tuple[list[dict], str | None]:
    """未登记后缀：内容像文本就按文本收（TS 侧前门嗅探同口径），否则明确拒收并给理由"""
    if looks_like_text(path):
        _note(f"后缀 {path.suffix or '(无)'} 未登记，内容像文本 → 按文本族收")
        return parse_text(path), None
    return [], f"内容既非可解码文本、后缀 {path.suffix or '(无)'} 也不在白名单（疑似二进制/损坏件）"


def _cell(v) -> str:
    return str(v).replace("|", "\\|") if v is not None else ""


def parse_excel(path: Path) -> tuple[list[dict], str | None]:
    """逐 sheet：整表一个原子块（行列关联不破坏）；台账型拒绝"""
    import openpyxl
    wb = openpyxl.load_workbook(str(path), data_only=True, read_only=True)
    blocks: list[dict] = []
    rejected: list[str] = []
    truncated = 0
    for ws in wb.worksheets:
        # ⚠️ 截断必须发生在**读取时**：旧写法先 `[[...] for r in ws.iter_rows(...)]` 把整表物化进内存，
        #    之后才切片 —— 百万元素的大表在切片之前就把内存吃光了，"巨表保险丝"名存实亡。
        rows: list[list[str]] = []
        over_cap = False
        for r in ws.iter_rows(values_only=True):
            if not any(str(c).strip() not in ("", "None") for c in r):
                continue
            if len(rows) >= SHEET_ROW_CAP:
                over_cap = True
                break
            rows.append([_cell(c) for c in r])
        if not rows:
            continue
        _inc("sheets_total")
        if len({c.strip().lower() for c in rows[0]} & LEDGER_HINTS) >= 3:
            rejected.append(ws.title)
            _inc("sheets_rejected")
            continue
        note = ""
        if over_cap:
            note = f"\n（超 {SHEET_ROW_CAP} 行已截断：这类大表请导入 MySQL 走 SQL 查询）"
            truncated += 1
            _inc("sheets_truncated")
        md_table = "\n".join([
            "| " + " | ".join(rows[0]) + " |",
            "|" + "---|" * len(rows[0]),
            *["| " + " | ".join(r) + " |" for r in rows[1:]],
        ]) + note
        blocks.append({"type": "heading", "level": 2, "markdown": f"工作表 {ws.title}"})
        blocks.append({"type": "table", "markdown": md_table})
    # ⚠️ 旧写法只在 `rejected and not blocks` 时才吐 reject：混装 workbook 里被拒的 sheet **无声消失**。
    #    现在：只要拒了就留痕迹（有块时走 notes，全拒时才用 reject 走人审出口）。
    if rejected:
        msg = f"台账型 sheet 拒入向量库（请走 MySQL）: {', '.join(rejected)}"
        if blocks:
            _note(msg)
        else:
            _finish_diag(blocks, "openpyxl")
            return blocks, msg
    if truncated:
        _note(f"{truncated} 个工作表超 {SHEET_ROW_CAP} 行已截断")
    return _finish_diag(blocks, "openpyxl"), None


# ── 入口函数的统一形状：PARSERS 表只认 `f(path) -> (blocks, reject)` ──
def _t(p: Path): return parse_text(p), None
def _c(p: Path): return parse_csv(p), None
def _i(p: Path): return parse_image(p), None
def _o(p: Path): return parse_office(p), None
def _h(p: Path): return parse_html(p), None
def _p(p: Path): return parse_pptx(p), None
def _d(p: Path): return parse_odf(p), None
def _r(p: Path): return parse_rtf(p), None
def _x(p: Path): return parse_pdf(p), None


# 扩展名口径与 TS 侧 src/rag/parse/formats.ts 逐字对齐（fromPy.test.ts 有跨语言一致性断言：
# 本表 key 集合必须 == PY_PARSER_EXT）。加扩展名先改 formats.ts 的 FAMILY_EXT，再回来加一行。
PARSERS = {
    ".pdf": _x,
    ".docx": _o,
    ".xlsx": parse_excel,
    ".pptx": _p,
    ".html": _h,
    ".htm": _h,
    ".xhtml": _h,
    ".odt": _d,
    ".ods": _d,
    ".odp": _d,
    ".rtf": _r,
    ".png": _i,
    ".jpg": _i,
    ".jpeg": _i,
    ".webp": _i,
    ".gif": _i,
    ".bmp": _i,
    ".tif": _i,
    ".tiff": _i,
    ".txt": _t,
    ".md": _t,
    ".markdown": _t,
    ".csv": _c,
    ".tsv": _c,
    ".json": _t,
    ".jsonl": _t,
    ".ndjson": _t,
    ".yaml": _t,
    ".yml": _t,
    ".toml": _t,
    ".ini": _t,
    ".cfg": _t,
    ".conf": _t,
    ".properties": _t,
    ".xml": _t,
    ".log": _t,
    ".rst": _t,
    ".tex": _t,
}


def main() -> int:
    global MEDIA
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--media-dir", dest="media", default=None,
                    help="图转文的落盘目录（TS 侧传 resources/<docId>/media）")
    args = ap.parse_args()
    if args.media:
        MEDIA = Path(args.media)
    path = Path(args.infile)
    entry = PARSERS.get(path.suffix.lower())
    try:
        if entry:
            result = entry(path)
            blocks, reject = (result[0], result[1]) if isinstance(result, tuple) else (result, None)
        else:
            # 未登记后缀 → 内容嗅探兜底（不是"不支持的格式"打发走）
            blocks, reject = parse_unknown(path)
        if not DIAG.get("extractor") or DIAG["extractor"] == "none":
            # 走到这里说明解析器没走 _finish_diag（早退/拒收路），补一个最基本的记账
            DIAG["extractor"] = "unknown"
            DIAG["chars"] = len("\n".join(b.get("markdown", "") for b in blocks if b.get("type") != "image"))
    except Exception as e:
        print(f"[parse.py] 解析失败 {path.name}: {e}", file=sys.stderr)
        DIAG.setdefault("notes", []).append(f"解析抛异常: {str(e)[:120]}")
        DIAG["extractor"] = "failed"
        print(json.dumps({"blocks": [], "reject": None, "diag": DIAG}, ensure_ascii=False))
        return 2
    print(f"[parse.py] {path.name}: blocks={len(blocks)} reject={reject or '无'} diag={ {k: v for k, v in DIAG.items() if k != 'notes'} }", file=sys.stderr)
    for nt in DIAG.get("notes", []):
        print(f"[parse.py]   · {nt}", file=sys.stderr)
    print(json.dumps({"blocks": blocks, "reject": reject, "diag": DIAG}, ensure_ascii=False))
    return 0 if blocks or not reject else 2


if __name__ == "__main__":
    # 契约行（末行 JSON）必须以 UTF-8 写出：Windows 下 stdout 走管道时按 locale 编码（如 cp936），
    # VL 描述里的 emoji/生僻字会让 print 抛 UnicodeEncodeError → stdout 一行都没有，
    # TS 侧（src/rag/parse/fromPy.ts）判「无契约输出」→ 白试多个解释器后走 fallback/隔离。stderr 同办，免得日志乱码。
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8")
    sys.exit(main())
