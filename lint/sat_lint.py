#!/usr/bin/env python3
"""Форк bds-wiki-articles/wiki_lint.py@744d3bb для статей сайтов-спутников (bds-satellites, ADR 0001).

Отличия от исходника — только профиль sat и аргументы --dir/--domain: каталог черновика и домен
сайта вместо bigdataschool.ru, баннеры cbanner запрещены (CTA — текстовая ссылка на курс), ссылки на
блог BDS не требуются. Остальные проверки Style Guide V10-Blog — как в исходнике.

    python3 lint/sat_lint.py <slug> --profile sat --dir <каталог черновика> --domain kafka-school.ru

Исходное описание: машинные проверки Wiki-статьи по чек-листу Этапа 3.5 и B8.

С профилем blog тот же скрипт проверяет статьи блога из blog_articles/ (плагин
bds-article): объём от 1800 слов, референсы на H2, лид не сверяется с заголовком Gutenberg, обязательны таблица сравнения и баннер
github_banner. Остальные проверки общие, отдельный линтер не заводим.

Скрипт закрывает ту часть проверки, которую можно посчитать, а не оценить на глаз.
Всё остальное (самодостаточность, каркас разделов, живой язык) остаётся за автором.

Запуск:
    python3 wiki_lint.py <slug> [--key "главное ключевое слово"]
    python3 wiki_lint.py --all
    python3 wiki_lint.py <slug> --published            проверка опубликованной страницы
    python3 wiki_lint.py <slug> --published-file page.txt   то же, но из сохранённой выгрузки
    python3 wiki_lint.py <slug> --profile blog         статья блога из blog_articles

Коды возврата: 0 если провалов нет, 1 если есть хотя бы один FAIL.
"""

import argparse
import html as html_mod
import json
import re
import sys
import urllib.request
from pathlib import Path

from wiki_unwrap import wrapped_lines

BASE = Path(__file__).resolve().parent
ARTICLES = BASE / "wiki_articles"

# Профиль задаёт то, чем статья блога отличается от Wiki. Всё, чего здесь нет, общее.
PROFILES = {
    "wiki": {
        "dir": "wiki_articles",
        "words": (1200, 1600),
        "colon_limit": 3,
        "refs_tag": "h3",
        "gutenberg_lead": True,
        "title_max": 56,
        "require_table": False,
        "require_github": False,
        "meta_status": False,
    },
    "blog": {
        "dir": "blog_articles",
        "words": (1800, None),
        "colon_limit": 5,
        "refs_tag": "h2",
        "gutenberg_lead": False,
        "title_max": 60,
        "require_table": True,
        "require_github": True,
        "meta_status": True,       # «Статус» и «Дата сдачи» нужны для квоты месяца
    },
    # Спутники: блог без баннеров и без ссылок на bigdataschool.ru; CTA — ссылка на курс сайта.
    "sat": {
        "dir": ".",
        "words": (1500, 2600),
        "colon_limit": 5,
        "refs_tag": "h2",
        "gutenberg_lead": False,
        "title_max": 60,
        "require_table": True,
        "require_github": False,
        "meta_status": False,
        "cbanners": 0,
        "require_blog_link": False,
    },
}
DOMAIN = "bigdataschool.ru"  # --domain у профиля sat
PROFILE = PROFILES["wiki"]


def set_profile(name: str, directory: str | None = None, domain: str | None = None) -> None:
    global ARTICLES, PROFILE, DOMAIN
    PROFILE = PROFILES[name]
    ARTICLES = Path(directory).resolve() if directory else BASE / PROFILE["dir"]
    if domain:
        DOMAIN = domain
USER_AGENT = "wiki_lint/1.0 (BigDataSchool internal check)"

COURSE_CODES = {
    "BDAM", "ARMG", "PRAR", "ARML", "PRUS", "STAR", "CLICH", "KAFKA", "DEVKI",
    "FLINK", "NIFI3", "AIRF", "TRINO", "HPPY", "MLOPS", "PYML", "PYNN", "AGENT",
    "CORS", "SPARK", "GPDE",
}
ALLOWED_SUFFIXES = {"_brief", "_research", "_meta", "_preview", "_runbook"}
CODE_LANGS = {"bash", "shell", "python", "sql", "java", "generic"}
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")


class Report:
    """Копилка результатов: строка на проверку плюс сводка в конце."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, status: str, name: str, comment: str = "") -> None:
        self.rows.append((status, name, comment))

    def check(self, ok: bool, name: str, comment_ok: str = "", comment_bad: str = "") -> None:
        self.add("ok" if ok else "FAIL", name, comment_ok if ok else comment_bad)

    @property
    def failed(self) -> int:
        return sum(1 for status, _, _ in self.rows if status == "FAIL")

    @property
    def warned(self) -> int:
        return sum(1 for status, _, _ in self.rows if status == "warn")

    def print(self) -> None:
        width = max(len(name) for _, name, _ in self.rows) + 2
        for status, name, comment in self.rows:
            print(f"  {status:<5} {name:<{width}} {comment}")


def strip_code(html: str) -> str:
    """Текст статьи без блоков кода: в них свои правила."""
    return re.sub(r"<pre.*?</pre>", " ", html, flags=re.S)



COLON_LIMIT = 3  # лимит Wiki; у профиля свой, см. PROFILES


def body_colons(html: str) -> list[str]:
    """Двоеточия в тексте статьи по B4 п.12.

    Из счёта выпадает то, где двоеточие несёт служебную роль, а не связывает мысли:
    блоки кода, заголовки (у них своя проверка), таблицы, шорткоды и атрибуты тегов,
    ввод списка по правилу сэндвича и идентификаторы вида qwen2.5vl:7b.
    Возвращает куски текста вокруг каждого попавшего в счёт двоеточия.
    """
    body = strip_code(html)
    body = re.sub(r"<table.*?</table>", " ", body, flags=re.S)
    body = re.sub(r"<h[1-6]>.*?</h[1-6]>", " ", body, flags=re.S)
    # ввод списка по правилу сэндвича: двоеточие в конце абзаца перед <ul>
    body = re.sub(r":\s*</p>\s*(?=<ul)", "</p>", body, flags=re.S)
    body = re.sub(r":\s*</li>", "</li>", body)
    body = re.sub(r"\[[a-z_]+[^\]]*\]", " ", body)      # шорткоды с url внутри
    plain = re.sub(r"<[^>]+>", " ", body)                 # атрибуты тегов вместе с ними
    plain = plain.replace("&nbsp;", " ")
    plain = re.sub(r"(?<=\w):(?=\d)", " ", plain)         # qwen2.5vl:7b, 3:1, 12:30
    return [plain[max(0, m.start() - 55):m.start() + 25].strip()
            for m in re.finditer(r":", plain)]


def sentences(html: str) -> list[str]:
    """Предложения из абзацев и пунктов списков, без кода и таблиц."""
    body = re.sub(r"<table.*?</table>", " ", strip_code(html), flags=re.S)
    result = []
    for block in re.findall(r"<(?:p|li)>(.*?)</(?:p|li)>", body, flags=re.S):
        block = re.sub(r"<[^>]+>", "", block)
        block = re.sub(r"\[[a-z_]+[^\]]*\]", "", block)
        result += [s for s in re.split(r"(?<=[.!?])\s+", " ".join(block.split())) if len(s.split()) > 1]
    return result


def is_excluded(sentence: str) -> bool:
    """Исключения по B4 п.3: определения и первое появление термина с оригиналом в скобках."""
    return bool(re.search(r"\([a-zA-Z][^)]*\)", sentence)) or " это " in sentence


def check_structure(html: str, report: Report) -> None:
    report.check(not re.search(r"<h1", html), "H1 в теле статьи", "нет", "найден тег H1")
    deep = re.findall(r"<h[4-6]", html)
    report.check(not deep, "Заголовки глубже H3", "нет", f"найдено {len(deep)}")

    headings = re.findall(r"<h[23]>", html)
    lines = html.splitlines()
    missing = [
        i for i, line in enumerate(lines)
        if re.match(r"\s*<h[23]>", line) and (i == 0 or lines[i - 1].strip() != "&nbsp;")
    ]
    report.check(not missing, "Отступ &nbsp; перед заголовками",
                 f"{len(headings)} заголовков, у всех есть",
                 f"нет отступа перед строками {[i + 1 for i in missing]}")

    bad_colon = [h for h in re.findall(r"<h[23]>(.*?)</h[23]>", html) if ":" in h]
    report.check(not bad_colon, "Двоеточия в заголовках", "нет", f"{bad_colon}")

    hits = body_colons(html)
    limit = PROFILE["colon_limit"]
    report.check(len(hits) <= limit, "Двоеточия в теле статьи",
                 f"{len(hits)} при лимите {limit}",
                 f"{len(hits)} при лимите {limit}, лишние: {hits[limit:]}")

    lead = re.search(r"^\s*<p>", html)
    report.check(bool(lead), "Статья начинается с лид-абзаца", "да", "первый блок не <p>")

    wrapped = wrapped_lines(html)
    report.check(not wrapped, "Блок одной строкой (без мягких переносов)",
                 "переносов внутри блоков нет",
                 f"{len(wrapped)} переносов внутри блоков, строки {wrapped[:10]}, "
                 f"лечится прогоном python3 wiki_unwrap.py <slug>"
                 + (" --profile blog" if PROFILE is PROFILES["blog"] else ""))

    if PROFILE["require_table"]:
        tables = re.findall(r"<table>.*?<thead>.*?</thead>.*?<tbody>.*?</tbody>.*?</table>", html, flags=re.S)
        report.check(bool(tables), "Таблица сравнения в HTML", f"{len(tables)} шт",
                     "нет таблицы <table><thead>...<tbody>, сравнение с альтернативами обязательно")


def check_banners(html: str, report: Report) -> None:
    codes = re.findall(r"\[cbanner code=([A-Z0-9]+)\]", html)
    if PROFILE.get("cbanners", 2) == 0:
        # На сайтах-спутниках шорткода баннера нет (решение автора, ADR 0001): CTA — ссылкой.
        report.check(not codes, "Баннеры cbanner отсутствуют", "нет", f"найдено {codes}, на спутнике шорткода нет")
        report.check("[github_banner" not in html, "Баннер github_banner отсутствует", "нет", "найден")
        return
    report.check(len(codes) == 2, "Ровно два баннера cbanner", f"{codes}", f"найдено {len(codes)}: {codes}")
    unknown = [c for c in codes if c not in COURSE_CODES]
    report.check(not unknown, "Коды курсов из списка A10", "все известны", f"неизвестные: {unknown}")

    lines = html.splitlines()
    no_nbsp = [
        i for i, line in enumerate(lines)
        if line.strip().startswith("[cbanner") and (i == 0 or lines[i - 1].strip() != "&nbsp;")
    ]
    report.check(not no_nbsp, "Отступ &nbsp; перед cbanner", "есть", f"строки {[i + 1 for i in no_nbsp]}")

    github = re.findall(r"\[github_banner url=\"([^\"]+)\"", html)
    if github:
        report.check(len(github) == 1, "Баннер github_banner", github[0], f"найдено {len(github)}")
    elif PROFILE["require_github"]:
        report.add("FAIL", "Баннер github_banner", "не найден, а практика в статье блога обязательна")
    else:
        report.add("warn", "Баннер github_banner", "не найден, ждём только в концептуальном режиме")


def mermaid_marks(html: str) -> list[str]:
    """Признаки кода Mermaid в статье. Слова 'mermaid' в таком блоке обычно нет.

    Ищем не по названию инструмента, а по синтаксису: init-блок с темой, объявление типа
    диаграммы первым словом строки и classDef. Смотрим только внутрь <pre>, чтобы обычный
    текст со словом «граф» или «диаграмма» ничего не ломал.
    """
    blocks = " ".join(re.findall(r"<pre.*?</pre>", html, flags=re.S))
    patterns = {
        "init-блок": r"%%\{\s*init\s*:",
        "объявление диаграммы": r"^\s*(?:flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?"
                               r"|erDiagram|journey|gantt|gitGraph|mindmap|timeline|quadrantChart)\b",
        "graph с направлением": r"^\s*graph\s+(?:LR|RL|TB|BT|TD)\b",
        "classDef": r"^\s*classDef\s+\w+\s+fill:",
    }
    return [name for name, pattern in patterns.items()
            if re.search(pattern, blocks, flags=re.M | re.I)]


def check_style(html: str, report: Report) -> None:
    text = strip_code(html)
    report.check("—" not in text, "Длинное тире", "нет", f"{text.count('—')} шт")
    report.check("<code" not in html, "Тег code", "нет", "найден")
    report.check("`" not in text, "Backtick вне блоков кода", "нет", f"{text.count('`')} шт")
    report.check("<hr" not in html, "Горизонтальный разделитель", "нет", "найден")
    # Эмодзи ищем только в тексте статьи. Внутри <pre> лежит реальный вывод
    # прогона, и если инструмент печатает статус эмодзи, править вывод нельзя:
    # отредактированный вывод перестаёт быть реальным.
    report.check(not EMOJI.search(text), "Эмодзи", "нет в тексте статьи", "найдены")
    marks = mermaid_marks(html)
    report.check(not marks, "Блоки Mermaid в HTML", "нет",
                 f"найден код схемы в статье: {marks}")

    md = re.findall(r"^#{1,6}\s|\*\*[^*]+\*\*|^\s*[-*]\s+\S", strip_code(html), flags=re.M)
    report.check(not md, "Markdown-разметка в HTML", "нет", f"{len(md)} совпадений: {md[:3]}")

    naked = strip_code(html)
    naked = re.sub(r"href=\"[^\"]*\"", "", naked)
    naked = re.sub(r"src=\"[^\"]*\"", "", naked)
    naked = re.sub(r"\[[a-z_]+[^\]]*\]", "", naked)
    urls = re.findall(r"https?://\S+", naked)
    report.check(not urls, "Голые URL в теле статьи", "нет", f"{urls[:3]}")


def check_links(html: str, report: Report) -> None:
    urls = re.findall(r'href="([^"]+)"', html)
    internal = [u for u in urls if DOMAIN in u]
    no_slash = [u for u in internal if not u.endswith("/")]
    report.check(not no_slash, "Внутренние URL со слэшем", f"{len(internal)} внутренних", f"{no_slash}")

    if PROFILE.get("require_blog_link", True):
        report.check(any("/blog/" in u for u in urls), "Ссылка на статью блога (A7)", "есть", "не найдена")
    report.check(any(DOMAIN in u and "/courses/" in u for u in urls), "Текстовая ссылка на курс (A7)", "есть", "не найдена")

    # Прямых ссылок на Wiki нет в обоих профилях: термины подсвечивает плагин Encyclopedia.
    wiki_links = [u for u in internal if "/wiki/" in u]
    report.check(not wiki_links, "Прямые ссылки на Wiki-страницы (A7.2)", "нет",
                 f"плагин Encyclopedia подсвечивает термины сам: {wiki_links}")

    # Заголовок референсов в Wiki с v6.6 всегда H3: в Содержании служебный хвост не должен
    # стоять наравне со смысловыми разделами. В блоге он H2, как в статьях серии v3.4.
    tag = PROFILE["refs_tag"]
    other = "h2" if tag == "h3" else "h3"
    refs_head = f"<{tag}>Референсные ссылки</{tag}>"
    body = re.split(re.escape(refs_head), html)[0]
    external_in_body = [u for u in re.findall(r'href="(https?://[^"]+)"', body)
                        if DOMAIN not in u and "bigdataschool.ru" not in u]
    report.check(bool(external_in_body), "Внешняя ссылка в теле статьи (A7.2)",
                 f"{len(external_in_body)} шт", "все внешние ссылки только в референсах")

    anchors = re.findall(r"<a href=\"[^\"]+\">(.*?)</a>", html, flags=re.S)
    weak = [a for a in anchors if re.sub(r"<[^>]+>", "", a).strip().lower() in
            {"здесь", "тут", "по этой ссылке", "ссылка", "читать"}]
    report.check(not weak, "Осмысленные анкоры", f"{len(anchors)} ссылок", f"слабые: {weak}")

    report.check(f"<{other}>Референсные ссылки</{other}>" not in html,
                 f"Референсы стоят на {tag.upper()}", "да",
                 f"заголовок референсов остался {other.upper()}, нужен {tag.upper()}")

    refs = re.search(re.escape(refs_head) + r"\s*<ul>(.*?)</ul>", html, flags=re.S)
    if refs:
        count = len(re.findall(r"<li>", refs.group(1)))
        report.check(3 <= count <= 5, "Референсов от 3 до 5", f"{count}", f"{count}")
    else:
        report.add("FAIL", "Референсных ссылок", f"раздел {refs_head} не найден")


def check_lead_and_seo(html: str, meta: str, report: Report) -> None:
    """Проверки v6.6: лид под плагин Encyclopedia и потолок SEO Title.

    Плагин подсвечивает термин на других страницах сайта и открывает popup только тогда,
    когда определение в лиде начинается ровно той же строкой, что стоит в заголовке
    статьи в Gutenberg. Расхождение выключает подсветку молча, без ошибки, поэтому
    сверка тут посимвольная.
    """
    found = re.search(r"\*\*Заголовок Gutenberg:\*\*\s*(.+)", meta)
    if not PROFILE["gutenberg_lead"]:
        pass  # в блоге Encyclopedia не работает, лид начинается с повода, а не с термина
    elif not found:
        report.add("FAIL", "Заголовок Gutenberg в метаданных",
                   "строки нет, лид сверять не с чем")
    else:
        title = found.group(1).strip().strip("`")
        lead = re.match(r"\s*<p>(.*?)</p>", html, flags=re.S)
        opening = re.sub(r"<[^>]+>", "", lead.group(1)).strip() if lead else ""
        report.check(opening.startswith(title), "Лид открывается заголовком Gutenberg",
                     f"{title!r}",
                     f"ожидалось начало {title!r}, найдено {opening[:len(title) + 20]!r}")

    seo = re.search(r"^-\s*\*\*Title:\*\*\s*(.+)$", meta, flags=re.M)
    if not seo:
        report.add("FAIL", "SEO Title в метаданных", "строки нет")
    else:
        value = seo.group(1).strip()
        cap = PROFILE["title_max"]
        report.check(len(value) <= cap, f"SEO Title до {cap} символов",
                     f"{len(value)} символов",
                     f"{len(value)} символов при потолке {cap}: {value!r}")

    if PROFILE["meta_status"]:
        status = re.search(r"^-\s*\*\*Статус:\*\*\s*(.+)$", meta, flags=re.M)
        done = re.search(r"^-\s*\*\*Дата сдачи:\*\*\s*(.+)$", meta, flags=re.M)
        report.check(bool(status and done), "Строки «Статус» и «Дата сдачи» в метаданных",
                     f"{status.group(1).strip() if status else ''}",
                     "нет строки, квота месяца не посчитается")


def check_images(html: str, meta: str, report: Report) -> None:
    imgs = re.findall(r"<img[^>]*>", html)
    todo = [i for i in imgs if "TODO_IMAGE" in i]
    report.check(len(imgs) == len(todo), "Плейсхолдер TODO_IMAGE во всех img",
                 f"{len(imgs)} картинок", f"{len(imgs) - len(todo)} без плейсхолдера")

    empty_alt = [i for i in imgs if not re.search(r'alt="[^"]{10,}"', i)]
    report.check(not empty_alt, "ALT заполнен у всех схем", "да", f"{len(empty_alt)} без внятного ALT")

    bad_class = [i for i in imgs if 'class="aligncenter size-full"' not in i]
    report.check(not bad_class, "Класс картинок aligncenter size-full", "да", f"{len(bad_class)} с другим классом")

    wp_id = [i for i in imgs if "wp-image-" in i]
    report.check(not wp_id, "Идентификаторы медиатеки в img", "нет", f"{len(wp_id)} с wp-image")

    if meta:
        # Каждая картинка статьи, будь то схема или скриншот, должна быть описана в метаданных.
        files = re.findall(r'src="TODO_IMAGE/([^"]+)"', html)
        orphans = [f for f in files if f not in meta]
        report.check(not orphans, "Картинки описаны в метаданных",
                     f"{len(files)} картинок, все есть в meta", f"нет описания: {orphans}")

        schemes = len(re.findall(r"^### Схема", meta, flags=re.M))
        mermaid_blocks = len(re.findall(r"%%\{init:", meta))
        report.check(schemes == mermaid_blocks and mermaid_blocks > 0, "Код Mermaid у каждой схемы",
                     f"{schemes} схем, {mermaid_blocks} блоков Mermaid",
                     f"{schemes} схем против {mermaid_blocks} блоков Mermaid")
        colors = all(c in meta for c in ("#294A70", "#FFAB1F", "#F5F7FA"))
        report.check(colors, "Фирменные цвета в схемах", "есть", "init-блок без палитры A8")


def check_code_blocks(html: str, report: Report) -> None:
    blocks = re.findall(r'<pre class="EnlighterJSRAW" data-enlighter-language="([a-z]+)">(.*?)</pre>',
                        html, flags=re.S)
    total_pre = len(re.findall(r"<pre", html))
    report.check(total_pre == len(blocks), "Все блоки кода в EnlighterJSRAW",
                 f"{len(blocks)} блоков", f"{total_pre - len(blocks)} блоков без разметки Enlighter")

    bad_lang = [lang for lang, _ in blocks if lang not in CODE_LANGS]
    report.check(not bad_lang, "Язык блоков из разрешённого списка", "да", f"{bad_lang}")

    no_pin = []
    for lang, body in blocks:
        if lang == "generic":
            continue
        first = body.strip().splitlines()[0].strip() if body.strip() else ""
        if not first.startswith(("#", "--", "//")):
            no_pin.append(first[:40])
    report.check(not no_pin, "Пин версии первой строкой кода", "во всех блоках", f"без пина: {no_pin}")

    stubs = re.findall(r"остальное как в|аналогично выше|\.\.\.\s*# пропущено", html)
    report.check(not stubs, "Заглушки вместо кода", "нет", f"{stubs}")


def fetch_published(url: str) -> str:
    """Страница с сайта. Запускает автор у себя, ассистент берёт страницу через свой web-инструмент."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read().decode("utf-8", errors="replace")


def published_images(text: str) -> dict[str, str]:
    """Имя файла картинки и её ALT. Понимает и сырой HTML, и markdown-выгрузку страницы."""
    found: dict[str, str] = {}
    for tag in re.findall(r"<img[^>]+>", text):
        src = re.search(r'src="([^"]+)"', tag)
        alt = re.search(r'alt="([^"]*)"', tag)
        if src:
            found.setdefault(src.group(1).rsplit("/", 1)[-1], html_mod.unescape(alt.group(1) if alt else ""))
    for alt, src in re.findall(r"!\[([^\]]*)\]\(([^)\s]+)", text):
        found.setdefault(src.rsplit("/", 1)[-1], html_mod.unescape(alt))
    return found


def canonical_url(slug: str, meta: str) -> str:
    """Wiki строит canonical из slug'а, блог берёт его из метаданных: там дефисы и рубрика."""
    found = re.search(r"\*\*Canonical URL:\*\*\s*(\S+)", meta)
    if PROFILE is PROFILES["blog"] and found:
        return found.group(1).strip("`")
    return f"https://bigdataschool.ru/wiki/{slug}/"


def check_published(slug: str, local_html: str, page: str, report: Report,
                    meta: str = "") -> None:
    """Проверки того, что реально опубликовано. Локальный файл может быть чист, а страница нет."""
    report.check(len(page) > 3000, "Страница отдаёт содержимое", f"{len(page)} символов",
                 "ответ подозрительно короткий, возможно 404 или редирект")
    report.check("TODO_IMAGE" not in page, "Плейсхолдеры TODO_IMAGE на странице", "нет",
                 f"{page.count('TODO_IMAGE')} штук, статья опубликована недоделанной")

    shortcodes = re.findall(r"\[(?:cbanner|github_banner)[^\]]*\]", page)
    report.check(not shortcodes, "Шорткоды отрендерились", "да",
                 f"на странице виден сырой текст шорткода: {shortcodes[:2]}")

    pub = published_images(page)
    mine = {name: alt for name, alt in pub.items() if name.startswith(slug)}
    expected = [f.rsplit("/", 1)[-1] for f in re.findall(r'src="TODO_IMAGE/([^"]+)"', local_html)]
    lost = [f for f in expected if f not in pub]
    report.check(not lost, "Картинки статьи загружены в медиатеку",
                 f"{len(mine)} картинок на странице", f"нет на странице: {lost}")

    bad_names = [n for n in mine
                 if re.search(r"-|wiki|article|screen|shot|final|_v\d|\d{4}", n.rsplit(".", 1)[0])]
    report.check(not bad_names, "Имена картинок по B0", f"{len(mine)} проверено",
                 f"нарушают правило: {bad_names}")

    weak_alt = [n for n, alt in mine.items() if len(alt.strip()) < 20]
    report.check(not weak_alt, "ALT картинок содержательные", "у всех",
                 f"пустой или слишком короткий ALT: {weak_alt}")

    heads_local = [re.sub(r"<[^>]+>", "", h).strip() for h in re.findall(r"<h[23]>(.*?)</h[23]>", local_html)]
    missing = [h for h in heads_local if h not in html_mod.unescape(page)]
    report.check(not missing, "Заголовки статьи на месте", f"{len(heads_local)} заголовков",
                 f"нет на странице: {missing[:3]}")

    canonical = canonical_url(slug, meta)
    report.check(canonical in page, "Canonical URL на странице", canonical,
                 "canonical не найден, проверьте slug страницы")


def check_names(slug: str, report: Report) -> None:
    report.check(re.fullmatch(r"[a-z0-9_]+", slug or ""), "Slug по B0",
                 slug, f"недопустимые символы в {slug!r}")
    found = sorted(p.name for p in ARTICLES.glob(f"{slug}*"))
    bad = []
    for name in found:
        stem = Path(name).stem
        if stem == slug:
            continue
        suffix = stem[len(slug):]
        if suffix not in ALLOWED_SUFFIXES:
            bad.append(name)
    report.check(not bad, "Суффиксы файлов из разрешённого списка", f"{found}", f"лишние: {bad}")
    report.check((ARTICLES / f"{slug}_meta.md").exists(), "Файл метаданных на месте",
                 f"{slug}_meta.md", "без него сдача не закрыта")


def stats(html: str, key: str, report: Report) -> dict:
    body = re.sub(r"<table.*?</table>", " ", strip_code(html), flags=re.S)
    plain = re.sub(r"<[^>]+>", " ", body).replace("&nbsp;", " ")
    plain = re.sub(r"\[[a-z_]+[^\]]*\]", " ", plain)
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9_.-]+", plain)

    sents = sentences(html)
    counted = [s for s in sents if not is_excluded(s)]
    long_ones = [s for s in counted if len(s.split()) > 15]
    share = round(len(long_ones) / len(counted) * 100) if counted else 0

    low, high = PROFILE["words"]
    label = f"Объём {low}-{high} слов" if high else f"Объём от {low} слов"
    report.check(low <= len(words) <= (high or len(words)), label, f"{len(words)}", f"{len(words)}")
    # Долю длинных предложений линтер считает, но проверкой не делает: см. B4 п.3.
    # Предупреждение по ней провоцировало разбавление текста короткими фразами ради
    # процента, а это худший дефект, чем сама длина. Число остаётся в статистике и
    # уезжает в реестр через lint_json.

    hits = len(re.findall(re.escape(key), html, flags=re.I)) if key else 0
    if key:
        first = sents[0] if sents else ""
        report.check(key.lower() in first.lower(), "Главный ключ в первом предложении",
                     f"{hits} вхождений всего", f"ключа нет в лид-абзаце, всего {hits} вхождений")

    numbers = {
        "words": len(words),
        "sentences": len(sents),
        "excluded": len(sents) - len(counted),
        "long_sentences": len(long_ones),
        "long_share": share,
        "key_hits": hits,
        "chars": len(html),
        "h2": len(re.findall(r"<h2>", html)),
        "h3": len(re.findall(r"<h3>", html)),
    }
    return numbers


def lint(slug: str, key: str | None, as_json: bool = False,
         published: bool = False, published_file: str | None = None) -> int:
    html_path = ARTICLES / f"{slug}.html"
    if not html_path.exists():
        print(f"нет файла {html_path}", file=sys.stderr)
        return 1
    html = html_path.read_text(encoding="utf-8")
    meta_path = ARTICLES / f"{slug}_meta.md"
    meta = meta_path.read_text(encoding="utf-8") if meta_path.exists() else ""

    if not key:
        found = re.search(r"\*\*Термин:\*\*\s*([^\n(]+)", meta)
        key = found.group(1).strip() if found else slug

    report = Report()
    check_structure(html, report)
    check_banners(html, report)
    check_style(html, report)
    check_links(html, report)
    check_lead_and_seo(html, meta, report)
    check_images(html, meta, report)
    check_code_blocks(html, report)
    check_names(slug, report)

    if published or published_file:
        try:
            page = (Path(published_file).read_text(encoding="utf-8", errors="replace")
                    if published_file else fetch_published(canonical_url(slug, meta)))
        except Exception as error:
            report.add("FAIL", "Опубликованная страница получена", str(error)[:80])
        else:
            check_published(slug, html, page, report, meta)

    if as_json:
        numbers = stats(html, key, report)
        payload = {
            "slug": slug,
            "checks": len(report.rows),
            "fails": report.failed,
            "warns": report.warned,
            "failed_items": [name for status, name, _ in report.rows if status == "FAIL"],
            **numbers,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 1 if report.failed else 0

    print(f"\n=== {slug} ===")
    numbers = stats(html, key, report)
    report.print()
    print()
    print("  Статистика для Части 3 метаданных:")
    print(f"    слов без кода и таблицы: {numbers['words']}")
    print(f"    предложений: {numbers['sentences']}, исключено по B4 п.3: {numbers['excluded']}")
    print(f"    длиннее 15 слов: {numbers['long_sentences']} из "
          f"{numbers['sentences'] - numbers['excluded']}, это {numbers['long_share']}%")
    if key:
        print(f"    вхождений главного ключа: {numbers['key_hits']}")
    print(f"    символов HTML: {numbers['chars']}")
    print(f"    заголовков H2/H3: {numbers['h2']}/{numbers['h3']}")
    print(f"\n  итог: провалов {report.failed}, предупреждений {report.warned}, "
          f"проверок всего {len(report.rows)}")
    return 1 if report.failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Машинные проверки Wiki-статьи")
    parser.add_argument("slug", nargs="?", help="slug статьи, файлы берутся из каталога профиля")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="wiki",
                        help="wiki (wiki_articles), blog (blog_articles) или sat (спутники, с --dir и --domain)")
    parser.add_argument("--dir", help="каталог со статьёй и метаданными (профиль sat)")
    parser.add_argument("--domain", help="домен сайта для внутренних ссылок (профиль sat)")
    parser.add_argument("--key", help="главное ключевое слово, по умолчанию берётся из метаданных")
    parser.add_argument("--all", action="store_true", help="прогнать по всем статьям каталога")
    parser.add_argument("--json", action="store_true",
                        help="машиночитаемый вывод для registry_tool.py add-article --from-lint")
    parser.add_argument("--published", action="store_true",
                        help="дополнительно проверить опубликованную страницу по canonical URL")
    parser.add_argument("--published-file",
                        help="то же, но страница берётся из сохранённой выгрузки, а не качается")
    args = parser.parse_args()
    if args.profile == "sat" and not (args.dir and args.domain):
        parser.error("профиль sat требует --dir и --domain")
    set_profile(args.profile, args.dir, args.domain)

    if args.all:
        slugs = sorted(p.stem for p in ARTICLES.glob("*.html"))
        return max(lint(s, args.key, args.json, args.published) for s in slugs) if slugs else 0
    if not args.slug:
        parser.error("укажите slug или --all")
    return lint(args.slug, args.key, args.json, args.published, args.published_file)


if __name__ == "__main__":
    sys.exit(main())
