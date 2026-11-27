# Каналы BDS по направлениям курсов (ADR 0005, п. 5)

bigdataschool.ru — главный сайт. Лучший материал по **всем** направлениям курсов сначала уходит в BDS, спутник
получает его, только если автор нажал «↪ Отдать спутнику» в Telegram или карточка не решена за 7 суток (ADR 0005,
п. 2–3). Направлений, которые целиком отданы спутнику, нет.

Канал доводит материал до карточки BDS одним из двух путей:

1. **Лента спутника.** Отбор спутника даёт `bds_offer` при `score_relevance >= select.bdsMinRelevance` (8) и
   `score_depth >= select.bdsMinDepth` (6). Так идут Kafka, Spark, Python, ML и AI.
2. **Конфиг `bds`, режим «только предложения».** Сбор → предотбор → отбор → `sat.bds_offers`, без черновиков и WP.
   Сюда идут каналы, которых нет ни у одного спутника. Режим `mode: offers` есть с 0.1.59.

Один канал в двух местах не держим: `sat.bds_offers` склеит URL, но видео будет смотреть дважды модель этапа video.

- Направления: 21 код курса из `stack-radar/src/lib/site/courses.ts` (`COURSE_PAGE`).
- Проверка 2026-11-27 с wsa100: `channel_id` взят со страницы `@handle` (`externalId`), лента
  `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` отдаёт 200, по заголовкам канал тот самый, указана дата
  последнего видео. Ни один новый канал не стоит в лентах спутников (grep по `bds-sat-*/config/site.yaml`).

## Покрытие направлений

| Курсы | Путь в BDS | Каналы |
|---|---|---|
| KAFKA, DEVKI | лента kafka | Confluent Developer, Confluent, Redpanda Data, Lenses, StreamNative, Developer Voices |
| SPARK, CORS | лента spark | Databricks, Advancing Analytics, DataTalksClub, Anyscale, MotherDuck, Onehouse, Delta Lake, CMU Database Group, PyData, DuckDB |
| HPPY, PYML, PYNN | лента python | Hugging Face, PyTorch, StatQuest, PyData, PyCon US, ArjanCodes, anthonywritescode, Talk Python, Pydantic, EuroPython, Seattle Data Guy, marimo, EuroSciPy |
| AGENT, MLOPS, ARML | конфиг `bds` (+ лента python) | LangChain, LlamaIndex, Anthropic, AI Engineer, DeepLearningAI, Weights & Biases |
| AIRF | конфиг `bds` | Apache Airflow, Astronomer, Kestra |
| FLINK | конфиг `bds` | Flink Forward, Ververica |
| TRINO | конфиг `bds` | Trino, Starburst |
| CLICH | конфиг `bds` | ClickHouse, Altinity |
| ARMG, PRAR | конфиг `bds` | dbt Labs, Apache Iceberg, Dremio |
| STAR, BDAM, PRUS | нет | не нашёл |
| GPDE, NIFI3 | не берём | технологии уходят, решение автора 2026-11-27 |

## Новые каналы для конфига `bds`

| Курс | Канал | channel_id | Последнее видео |
|---|---|---|---|
| AIRF | Apache Airflow | UCSXwxpWZQ7XZ1WL3wqevChA | 2026-11-19 |
| AIRF | Astronomer | UCcPZvKtWyYq6d_kCbjyTRSQ | 2026-11-25 |
| AIRF (альтернатива) | Kestra | UCMCsjAEnJXzGsg_IAZF8WHQ | 2026-11-23 |
| FLINK | Flink Forward | UCY8_lgiZLZErZPF47a2hXMA | 2025-11-13 (записи конференции, раз в год) |
| FLINK | Ververica | UCxt7B_fmLplq0OMRVxLiE8w | 2026-08-21 |
| TRINO | Trino | UCpqxUwvIA6vaXW45KO1GMhA | 2026-11-25 |
| TRINO | Starburst | UCXjkuWSO9CV_cSI3Mvo4a4w | 2026-11-02 |
| CLICH | ClickHouse | UChtmrD-dsdpspr42P_PyRAw | 2026-11-27 |
| CLICH | Altinity | UCE3Y2lDKl_ZfjaCrh62onYA | 2026-11-07 |
| ARMG, PRAR | dbt Labs | UCVpBwKK-ecMEV75y1dYLE5w | 2026-11-10 |
| ARMG, PRAR | Apache Iceberg | UCAg-s6wxgQRmEBohfuWTEXA | 2026-11-25 |
| ARMG, PRAR | Dremio | UCp5-3pDnAC0HMSh5NBl40Ww | 2026-11-11 |
| AGENT | LangChain | UCC-lyoTfSrcJzA1ab3APAgw | 2026-11-26 |
| AGENT | LlamaIndex | UCeRjipR4_SsCddq9VZ2AeKg | 2026-11-18 |
| AGENT | Anthropic | UCrDwWp7EBBv4NwvScIpBDOA | 2026-11-19 |
| AGENT, ARML | AI Engineer | UCLKPca3kwwd-B59HNr-_lvA | 2026-11-27 |
| PYNN, AGENT | DeepLearningAI | UCcIXc5mJsHVYTZR1maL5l9w | 2026-11-24 |
| MLOPS, ARML | Weights & Biases | UCAoex7Afqs1bWf5Xy8xaSfQ | 2026-11-27 |

## Под вопросом

| Курс | Канал | channel_id | Почему |
|---|---|---|---|
| ARMG | Data Mesh Learning | UC3bSfMzhHjeX_tFdte1esgQ | последнее видео 2025-10-10 |
| ARMG | Thoughtworks | UCQvdU25Eqk3YS9-QnILhKKQ | живой, но в основном общий AI и конференции на португальском; только без `topical` |

## Не нашёл

- STAR (StarRocks): канал `@StarRocks` пустой, `@CelerData` нет.
- BDAM, PRUS (аналитика для бизнеса): канала по теме не подобрал.
- Отбраковка: `@Risingwave`, `@Conduktor`, `@Prefect`, `@Airbyte`, `@JoeReis` и `@preset` указывают на чужие или
  мёртвые каналы.

## Блок для конфига `bds`

```yaml
sources:
  - { id: yt-airflow, kind: youtube, topical: true, title: Apache Airflow, channel_id: UCSXwxpWZQ7XZ1WL3wqevChA }
  - { id: yt-astronomer, kind: youtube, title: Astronomer, channel_id: UCcPZvKtWyYq6d_kCbjyTRSQ }
  - { id: yt-kestra, kind: youtube, title: Kestra, channel_id: UCMCsjAEnJXzGsg_IAZF8WHQ }
  - { id: yt-flink-forward, kind: youtube, topical: true, title: Flink Forward, channel_id: UCY8_lgiZLZErZPF47a2hXMA }
  - { id: yt-ververica, kind: youtube, title: Ververica, channel_id: UCxt7B_fmLplq0OMRVxLiE8w }
  - { id: yt-trino, kind: youtube, topical: true, title: Trino, channel_id: UCpqxUwvIA6vaXW45KO1GMhA }
  - { id: yt-starburst, kind: youtube, title: Starburst, channel_id: UCXjkuWSO9CV_cSI3Mvo4a4w }
  - { id: yt-clickhouse, kind: youtube, topical: true, title: ClickHouse, channel_id: UChtmrD-dsdpspr42P_PyRAw }
  - { id: yt-altinity, kind: youtube, title: Altinity, channel_id: UCE3Y2lDKl_ZfjaCrh62onYA }
  - { id: yt-dbt, kind: youtube, title: dbt Labs, channel_id: UCVpBwKK-ecMEV75y1dYLE5w }
  - { id: yt-iceberg, kind: youtube, topical: true, title: Apache Iceberg, channel_id: UCAg-s6wxgQRmEBohfuWTEXA }
  - { id: yt-dremio, kind: youtube, title: Dremio, channel_id: UCp5-3pDnAC0HMSh5NBl40Ww }
  - { id: yt-langchain, kind: youtube, title: LangChain, channel_id: UCC-lyoTfSrcJzA1ab3APAgw }
  - { id: yt-llamaindex, kind: youtube, title: LlamaIndex, channel_id: UCeRjipR4_SsCddq9VZ2AeKg }
  - { id: yt-anthropic, kind: youtube, title: Anthropic, channel_id: UCrDwWp7EBBv4NwvScIpBDOA }
  - { id: yt-ai-engineer, kind: youtube, title: AI Engineer, channel_id: UCLKPca3kwwd-B59HNr-_lvA }
  - { id: yt-deeplearningai, kind: youtube, title: DeepLearningAI, channel_id: UCcIXc5mJsHVYTZR1maL5l9w }
  - { id: yt-wandb, kind: youtube, title: Weights & Biases, channel_id: UCAoex7Afqs1bWf5Xy8xaSfQ }
```
