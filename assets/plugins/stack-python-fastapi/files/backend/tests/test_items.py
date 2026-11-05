from fastapi.testclient import TestClient


def test_create_and_list_items(client: TestClient) -> None:
    assert client.get("/items").json() == []

    created = client.post("/items", json={"name": "first"})
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "first"
    assert body["id"] == 1
    assert "created_at" in body

    assert [item["name"] for item in client.get("/items").json()] == ["first"]


def test_rejects_invalid_items(client: TestClient) -> None:
    assert client.post("/items", json={"name": ""}).status_code == 422
    assert client.post("/items", json={"name": "x" * 201}).status_code == 422
    assert client.post("/items", json={}).status_code == 422
