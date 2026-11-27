# Каналы BDS по направлениям курсов (ADR 0005, п. 5)

Список YouTube-каналов для тем bigdataschool.ru, у которых нет своего спутника. Он станет блоком `sources`
конфига `bds` в режиме «только предложения» (сбор → предотбор → отбор → `sat.bds_offers`, без черновиков и WP).
Этого режима в коде пока нет. Список готовят заранее, режим — отдельной задачей.

- Направления: коды курсов из `stack-radar/src/lib/site/courses.ts` (`COURSE_PAGE`).
- Направления со спутником не входят: KAFKA/DEVKI → kafka, SPARK/CORS → spark, HPPY/PYML/PYNN/MLOPS/ARML/AGENT →
  python (темы `bds-sat-python/config/site.yaml`: ML, AI-агенты, MLOps).
- Проверка 2026-11-27 с wsa100: `channel_id` взят со страницы `@handle` (`externalId`), лента
  `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` отдаёт 200, по заголовкам канал тот самый, указана дата
  последнего видео. Ни один канал не стоит в лентах спутников (grep по `bds-sat-*/config/site.yaml`).

## Берём

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

## Под вопросом

| Курс | Канал | channel_id | Почему |
|---|---|---|---|
| ARMG | Data Mesh Learning | UC3bSfMzhHjeX_tFdte1esgQ | последнее видео 2025-10-10 |
| ARMG | Thoughtworks | UCQvdU25Eqk3YS9-QnILhKKQ | живой, но в основном общий AI и конференции на португальском; только без `topical` |
| GPDE | Greenplum Database | UCIC2TGO-4xNSAJFCJXlJNwA | последнее видео 2025-12-15 |

## Не нашёл

- STAR (StarRocks): канал `@StarRocks` пустой, `@CelerData` нет.
- NIFI3 (Apache NiFi): `@ApacheNiFi`, `@apachenifi` и `@Datavolo` не найдены.
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
```
