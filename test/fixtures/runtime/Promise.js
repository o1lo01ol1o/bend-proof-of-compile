io_eff(CID(later), () => {
  switch (process.env.POC_RUNTIME_CASE) {
    case "reject":
      return new Promise((_, reject) => setTimeout(() => reject(new Error("host rejected effect")), 5));
    case "undefined":
      return Promise.resolve(undefined);
    case "thenable":
      return { then: (resolve) => setTimeout(() => resolve(42), 5) };
    case "sync":
      return 42;
    default:
      return new Promise((resolve) => setTimeout(() => resolve(42), 30));
  }
});
