.PHONY: up down restart logs deploy

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

deploy:
	git pull
	docker compose up -d --build
