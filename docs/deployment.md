# MetaStocker на vintage-shop-prod

Production: **https://metastocker.net**, IPv4 **178.105.209.209**, SSH **vintage-shop-prod**.
`www.metastocker.net` и HTTP перенаправляются на HTTPS основного домена с сохранением пути и query string.
Netlify остаётся DNS-провайдером; проект и DNS-зона не удаляются. Push в GitHub сам по себе не выпускает новую версию на VPS.

## Устройство хостинга

- Общий входной Caddy: контейнер `vintage-inventory-caddy-1`, серверный файл `/opt/vintage-inventory/Caddyfile`.
- Для MetaStocker в него добавлен только `deploy/Caddyfile.fragment`. Остальные сайты и настройки общего Caddy сохраняются.
- Статический контейнер `metastocker-web` доступен Caddy по сети `vintage-inventory_default`, порт 8080. На хост дополнительные порты не публикуются.
- Изолированный Compose-проект `metastocker`; конфигурация `/opt/metastocker/compose.yaml`. Образ Caddy закреплён по digest. Лимит памяти контейнера 128 MiB.
- `/opt/metastocker/releases/<UTC>-<commit>/public` — файлы конкретного релиза.
- `/opt/metastocker/current` — активный релиз; `/opt/metastocker/previous` — предыдущий.
- `Staticfile` внутри релиза — конфигурация статического сервера с перенесёнными `_headers`, корректным MIME для `.mjs`/`.wasm`, revalidation кеша и поддержкой существующих HTML URL без расширения.
- `SHA256SUMS` проверяется перед активацией; `/release.json` сообщает release, commit, версию и хеши публичных файлов.
- `/opt/metastocker/backups/` — резервные копии конфигурации и указатели предыдущих релизов, доступны только root. Старые релизы автоматически не удаляются.

На сервере нет AI-движка, весов моделей и API-ключей. WebGPU, Workers, загрузка моделей, Thinking и генерация продолжают работать в браузере посетителя. CacheStorage привязан к прежнему HTTPS-домену, поэтому смена хостинга сама по себе не очищает уже скачанные модели. Браузер всё ещё может удалять кеш по своим правилам.

## Следующее обновление

Нужны Git, Node.js, Python 3, rsync и настроенный SSH-доступ. Из каталога репозитория:

```sh
git status --short
# Проверить изменения, увеличить видимую версию и записать изменения в AGENTS.md.
git add <изменённые-файлы>
git commit -m "Release MetaStocker ..."
git push origin main
bash deploy/deploy.sh vintage-shop-prod
```

Скрипт требует чистое рабочее дерево, запускает JS/Python-проверки, собирает только закоммиченный HEAD, передаёт новый неизменяемый релиз и проверяет SHA-256 на сервере. Затем валидирует Caddy/Compose, сохраняет предыдущую конфигурацию, атомарно переключает `current` и перезагружает только статический сервер MetaStocker. При ошибке активации возвращает предыдущий релиз. Последняя стадия проверяет публичный HTTPS, IP, содержимое всех файлов, заголовки, блог, редиректы и недоступность служебных файлов.

Если финальная публичная проверка не прошла, скрипт завершится ошибкой; изучить вывод и выполнить откат ниже. Ошибка внешнего DNS/интернета не вызывает автоматическое переключение уже работающего релиза.

`--bootstrap` вторым аргументом применяется только при первоначальной установке, когда маршруты общего Caddy ещё не созданы; он пропускает публичную проверку. Для обычных выпусков этот флаг не использовать.

Веб-корень собирается из явного списка файлов и каталогов `assets/`, `blog/`. `.git`, тесты, документация, скрипты и `_headers` не публикуются. `_redirects` и `netlify.toml` сейчас отсутствуют. Сборщик остановится, если они появятся или `_headers` получит новые правила по путям: такие настройки нужно сначала явно перенести.

## Откат

Вернуться к предыдущему релизу:

```sh
bash deploy/rollback.sh vintage-shop-prod
```

Посмотреть релизы и выбрать конкретный:

```sh
ssh vintage-shop-prod 'readlink /opt/metastocker/current; readlink /opt/metastocker/previous; ls -1 /opt/metastocker/releases'
bash deploy/rollback.sh vintage-shop-prod <release-id>
```

Откат использует ту же проверку контрольных сумм, валидацию и публичные проверки; DNS и общий Caddy не меняются. Временные файлы браузера, скачанные модели и открытые сессии пользователей скрипты не затрагивают.

## Общий Caddy и HTTPS

Сертификаты основного и www-домена выпускает и автоматически продлевает уже работающий Caddy. ACME-состояние хранится в постоянном Docker volume `vintage-inventory_caddy_data`, настройки — `vintage-inventory_caddy_config`. Для продления должны оставаться доступны DNS и TCP 80/443. Отдельный certbot/cron не нужен. Общий Caddy сейчас обслуживает HTTP/1.1 и HTTP/2; UDP 443 не опубликован, этот перенос не включает HTTP/3.

Перед любым редактированием общего Caddy сохранить его файл, runtime JSON и оба volume в root-only каталоге резервной копии. Проверить, что серверная конфигурация не изменилась с момента чтения. Изменения сначала проверять командой `caddy validate`. После успешной проверки записывать конфигурацию **в существующий файл**, сохраняя inode bind mount, и выполнять `caddy reload`, без пересоздания общего контейнера. Не заменять общий Caddyfile фрагментом MetaStocker и не запускать `docker compose down` для общего проекта.

Восстановление общего Caddy требуется только при проблемах с его конфигурацией. Сначала проверить, что после резервной копии другие проекты не добавили своих изменений; при наличии изменений убрать/исправить только блок `BEGIN METASTOCKER`…`END METASTOCKER`. Полное восстановление старого файла без такой проверки может повредить соседним сайтам.

```sh
ssh vintage-shop-prod 'docker exec vintage-inventory-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh vintage-shop-prod 'docker exec vintage-inventory-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile'
```

Основа HTTPS: [документация Caddy](https://caddyserver.com/docs/automatic-https). Изменения общего Caddy при каждом выпуске MetaStocker не требуются.

## Проверка и диагностика

```sh
python3 deploy/verify_production.py
curl -I https://metastocker.net/
curl -I 'https://www.metastocker.net/blog/?check=1'
ssh vintage-shop-prod 'docker ps --filter name=metastocker-web; docker logs --tail 50 metastocker-web'
ssh vintage-shop-prod 'docker logs --since 15m vintage-inventory-caddy-1 2>&1 | grep metastocker'
```

В браузере проверить импорт изображения, выбор локальной модели без автоматического скачивания, явную загрузку, генерацию, экспорт CSV, выгрузку/повторную загрузку/удаление модели. Убедиться, что браузер видит HTTPS и WebGPU, `.mjs` получает JavaScript MIME, нет CSP-ошибок, при локальной генерации отсутствуют обращения к облачному AI API. Проверка HTTP не заменяет реальную WebGPU-проверку на совместимом компьютере.

После изменений общего Caddy дополнительно сверять конфигурацию старых маршрутов, ID/время запуска соседних контейнеров и доступность Luka Vintage, Tuner, Submitly/Stockscope. Сайт Лука и его приложения не должны пересоздаваться во время выпуска MetaStocker.
