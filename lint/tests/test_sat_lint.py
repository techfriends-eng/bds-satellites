"""Эталоны линтера профиля sat (handbook standards/06: линтер-тест с эталонными входами и выходами)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

LINT = Path(__file__).resolve().parents[1] / "sat_lint.py"
SLUG = "kafka_quorum_loss"
DOMAIN = "kafka-school.ru"

PARA = ("<p>Контроллеры KRaft реплицируют журнал метаданных, и потеря большинства останавливает запись "
        "новых метаданных, хотя чтение данных брокерами какое-то время продолжается без изменений.</p>")

META = f"""# Метаданные статьи Потеря кворума KRaft

- **Термин:** KRaft
- **Заголовок статьи:** Потеря кворума контроллеров KRaft
- **Slug:** {SLUG}

## Часть 2. Визуализации

### Превью-картинка

- **Имя файла:** `{SLUG}_preview.jpg`
- **ALT:** Схема кворума контроллеров KRaft на стенде из трёх узлов

### Схема 1. Кворум

- **Имя файла:** `{SLUG}_scheme1.jpg`
- **ALT:** Три контроллера KRaft и брокер-наблюдатель

```mermaid
%%{{init: {{'theme':'base', 'themeVariables': {{'primaryColor':'#294A70','secondaryColor':'#FFAB1F','tertiaryColor':'#F5F7FA'}}}}}}%%
flowchart LR
  a --> b
```

## SEO

- **Title:** Потеря кворума KRaft на практике
"""


def good_html() -> str:
    body = "\n".join([PARA] * 70)
    return "\n".join([
        "<p>KRaft хранит метаданные кластера в кворуме контроллеров, и разбор ниже показывает, что ломается без большинства.</p>",
        "&nbsp;",
        "<h2>Что хранится в кворуме</h2>",
        body,
        '<p>Подробности описаны в <a href="https://kafka.apache.org/documentation/">документации Apache Kafka</a>.</p>',
        f'<img class="aligncenter size-full" src="TODO_IMAGE/{SLUG}_scheme1.jpg" alt="Три контроллера KRaft и брокер-наблюдатель" />',
        "&nbsp;",
        "<h2>Сравнение режимов</h2>",
        "<table><thead><tr><th>Режим</th><th>Кворум</th></tr></thead><tbody><tr><td>KRaft</td><td>большинство</td></tr></tbody></table>",
        "&nbsp;",
        "<h2>Практика на стенде</h2>",
        '<pre class="EnlighterJSRAW" data-enlighter-language="bash"># Kafka 4.3.2, стенд progon\ndocker compose up -d</pre>',
        "<!-- output run.sh -->",
        '<pre class="EnlighterJSRAW" data-enlighter-language="generic">Container started</pre>',
        f'<p>Разобрать кворум на практике помогает курс <a href="https://{DOMAIN}/courses/apache-kafka-administrator-course/">Администрирование кластера Kafka</a>.</p>',
        "&nbsp;",
        "<h2>Референсные ссылки</h2>",
        "<ul><li><a href=\"https://aiven.io/blog/kafka-never-lose-quorum\">Never lose quorum</a></li>"
        "<li><a href=\"https://kafka.apache.org/documentation/\">Kafka documentation</a></li>"
        "<li><a href=\"https://cwiki.apache.org/confluence/display/KAFKA/KIP-853\">KIP-853</a></li></ul>",
    ])


def run(html: str) -> dict:
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / f"{SLUG}.html").write_text(html, encoding="utf-8")
        (Path(d) / f"{SLUG}_meta.md").write_text(META, encoding="utf-8")
        out = subprocess.run([sys.executable, str(LINT), SLUG, "--profile", "sat", "--dir", d,
                              "--domain", DOMAIN, "--key", "KRaft", "--json"],
                             capture_output=True, text=True, check=False)
        return json.loads(out.stdout)


class SatLint(unittest.TestCase):
    def test_reference_article_passes(self) -> None:
        res = run(good_html())
        self.assertEqual(res["failed_items"], [])

    def test_defects_from_review_fail(self) -> None:
        bad = (good_html()
               .replace("<h2>Сравнение режимов</h2>", "<h2>Разбор: сравнение режимов</h2>")
               .replace("журнал метаданных", "журнал <code>__cluster_metadata</code> — метаданных", 1)
               .replace("&nbsp;\n<h2>Практика", "&nbsp;\n[cbanner code=KAFKA]\n\n&nbsp;\n<h2>Практика"))
        failed = set(run(bad)["failed_items"])
        self.assertTrue({"Двоеточия в заголовках", "Тег code", "Длинное тире",
                         "Баннеры cbanner отсутствуют"} <= failed, failed)


if __name__ == "__main__":
    unittest.main()
