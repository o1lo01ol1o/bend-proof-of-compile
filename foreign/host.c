/*
 * proof-of-compile currently publishes a JavaScript library and CLI.  Host
 * capabilities are implemented in host.js; this companion keeps Bend's
 * foreign-source pair explicit and makes an accidental native build fail at
 * link time rather than silently changing cache semantics.
 */
