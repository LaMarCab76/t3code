import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Tab moves from the add-project Git URL field to its submit button",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    await t3.open();

    const projects = screen.getByRole("combobox", "Projects");
    if (await projects.isVisible()) {
      await projects.tap();
      await screen.getByRole("option", "Add project").tap();
    } else {
      await screen.getByRole("button", "Add project").tap();
    }
    await screen.getByText("Git URL").tap();
    await screen.getByRole("combobox").fill("https://github.com/pingdotgg/t3code.git");
    const submit = screen.getByRole("button", "Continue (Enter)");
    await expect(submit).toBeEnabled();

    await browser.keyboard.press("Tab");
    await app.screenshot("after-tab");
    await expect(submit).toBeFocused();
  },
);
