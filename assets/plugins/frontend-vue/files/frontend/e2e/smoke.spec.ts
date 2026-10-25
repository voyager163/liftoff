import { expect, test } from "@playwright/test";

// Runs against the whole application: the frontend container, the API and
// PostgreSQL. Start them first with `docker compose up --build --wait`.
test("reaches the API through the frontend and saves an item", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("API ready")).toBeVisible();

  const name = `browser test ${Date.now()}`;
  await page.getByLabel("New item").fill(name);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: name }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("listitem").filter({ hasText: name }),
  ).toBeVisible();
});
