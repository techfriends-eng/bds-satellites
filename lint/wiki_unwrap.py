#!/usr/bin/env python3
"""Снимает мягкие переносы строк внутри блоков HTML-статьи.

Зачем. Статья сдаётся в блок «Пользовательский HTML» классического редактора
WordPress, а он прогоняет текст через wpautop. Тот превращает одиночный перенос
строки внутри абзаца в тег <br />, и абзац на сайте рвётся на короткие строки
вместо нормальной вёрстки по ширине колонки. В редакторе это не видно, видно уже
на опубликованной странице, и правится руками.

Правило простое: один блок это одна строка файла. Переносы остаются только между
блоками и внутри <pre>, где они значимы.

Запуск:
    python3 wiki_unwrap.py <slug>          переписать файл статьи
    python3 wiki_unwrap.py <slug> --check  только сказать, есть ли переносы
    python3 wiki_unwrap.py --all           пройти по всем статьям
    python3 wiki_unwrap.py --all --check
    python3 wiki_unwrap.py <slug> --profile blog   статья блога из blog_articles

Коды возврата: 0 если всё чисто (или файл переписан), 1 если при --check нашлись
переносы внутри блоков.
"""

import argparse
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
ARTICLES = BASE / "wiki_articles"
PROFILE_DIRS = {"wiki": "wiki_articles", "blog": "blog_articles"}  # как PROFILES в wiki_lint.py

BLOCK_TAGS = (r"p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote"
              r"|pre|div|figure|figcaption|section|article")

# Строка начинает новый блок: открывающий или закрывающий блочный тег,
# служебный отступ &nbsp;, картинка, разделитель, комментарий.
BLOCK_OPEN = re.compile(
    r"^\s*(?:&nbsp;|<!--|\[(?:github_banner|cbanner)\b|<(?:img|hr|br)\b"
    r"|</?(?:" + BLOCK_TAGS + r")\b)", re.I)

# Строка закончила блок: закрывающий блочный тег, самозакрытый тег, &nbsp;.
BLOCK_CLOSE = re.compile(
    r"(?:&nbsp;|-->|/>|<(?:hr|br)\s*/?>|</(?:" + BLOCK_TAGS + r")>)\s*$", re.I)


def unwrap(html: str) -> str:
    """Склеивает строки, разорванные внутри одного блока. <pre> не трогает."""
    parts = re.split(r"(<pre.*?</pre>)", html, flags=re.S)
    out: list[str] = []
    for index, part in enumerate(parts):
        if index % 2:            # это блок кода, в нём переносы значимы
            out.append(part)
            continue
        buffer: list[str] = []
        for line in part.split("\n"):
            if not buffer:
                buffer.append(line)
                continue
            previous = buffer[-1]
            keep = (not line.strip() or not previous.strip()
                    or BLOCK_OPEN.match(line) or BLOCK_CLOSE.search(previous))
            if keep:
                buffer.append(line)
            else:
                buffer[-1] = previous.rstrip() + " " + line.lstrip()
        out.append("\n".join(buffer))
    return "".join(out)


def wrapped_lines(html: str) -> list[int]:
    """Номера строк, которые были приклеены к предыдущей. Для отчёта линтера."""
    if unwrap(html) == html:
        return []
    bad: list[int] = []
    parts = re.split(r"(<pre.*?</pre>)", html, flags=re.S)
    number = 1
    for index, part in enumerate(parts):
        lines = part.split("\n")
        if index % 2:
            number += len(lines) - 1
            continue
        for position, line in enumerate(lines):
            if position and line.strip() and lines[position - 1].strip() \
                    and not BLOCK_OPEN.match(line) \
                    and not BLOCK_CLOSE.search(lines[position - 1]):
                bad.append(number)
            if position:
                number += 1
    return bad


def process(slug: str, check_only: bool) -> int:
    path = ARTICLES / f"{slug}.html"
    if not path.exists():
        print(f"нет файла {path}", file=sys.stderr)
        return 1
    html = path.read_text(encoding="utf-8")
    fixed = unwrap(html)
    if fixed == html:
        print(f"{slug}: чисто")
        return 0
    bad = wrapped_lines(html)
    if check_only:
        print(f"{slug}: FAIL, переносы внутри блоков, строк {len(bad)}: {bad[:10]}")
        return 1
    path.write_text(fixed, encoding="utf-8")
    print(f"{slug}: склеено строк {len(bad)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Снятие мягких переносов в HTML статьи")
    parser.add_argument("slug", nargs="?")
    parser.add_argument("--all", action="store_true", help="пройти по всем статьям")
    parser.add_argument("--check", action="store_true", help="не править, только проверить")
    parser.add_argument("--profile", choices=sorted(PROFILE_DIRS), default="wiki",
                        help="wiki (wiki_articles) или blog (blog_articles)")
    args = parser.parse_args()
    global ARTICLES
    ARTICLES = BASE / PROFILE_DIRS[args.profile]

    if args.all:
        slugs = sorted(p.stem for p in ARTICLES.glob("*.html"))
    elif args.slug:
        slugs = [args.slug]
    else:
        parser.error("нужен slug или --all")

    return max(process(slug, args.check) for slug in slugs)


if __name__ == "__main__":
    sys.exit(main())
