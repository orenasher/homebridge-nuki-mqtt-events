# homebridge-nuki-mqtt-events

Momentary HomeKit switches that turn **on for ~1 second** whenever a Nuki Smart Lock is opened from the Keypad 2 by **fingerprint** or **code**, using the Nuki local MQTT API (`nuki/<ID>/lockActionEvent`).

Typical use: an Apple Home automation *"When Nuki Fingerprint turns on → set Security System to Off"* — so the alarm is disarmed only by fingerprint/code, never when the door is opened from inside or from the app.

## Fully standalone (v1.1+)
The plugin includes its own **built-in MQTT broker**. No Home Assistant, Mosquitto or other script is needed:

1. In the Nuki app: *Features & Configuration → Smart Home → MQTT* → Host = the IP of your Homebridge server, plus the username/password you set in the plugin.
2. That's it — the switch reacts directly.

Home Assistant can still use the lock: point Home Assistant's MQTT integration at the Homebridge server's IP (port 1883, same login). Auto-discovery keeps working, and retained messages are saved across restarts.

Prefer an existing broker? Set **MQTT broker → External** and enter its host.

## Config
```json
{
  "platform": "NukiMqttEvents",
  "brokerMode": "embedded",
  "brokerPort": 1883,
  "username": "nuki",
  "password": "********",
  "deviceId": "4E2CC127",
  "switches": [
    { "name": "Nuki Fingerprint", "sources": ["fingerprint"] },
    { "name": "Nuki Code", "sources": ["code"] }
  ]
}
```
`codeIds` limits a switch to specific people. Every event is logged with its Code ID so you can find them.

## Matter door lock with door position (v1.2, experimental)

iOS 27.2 adds **Lock After Closing** and **Door Left Open** for Matter locks that report a door position sensor. The Nuki does not report its door state over Matter, so the plugin can run its own **standalone Matter lock** (own pairing code, not bridged) with the Door Position Sensor feature:

- Lock / unlock from Home is sent to the Nuki over MQTT (`nuki/<id>/lockAction`) and confirmed by `nuki/<id>/state`. Enable lock actions in the Nuki app's MQTT settings.
- The door position comes from a HomeKit switch the plugin adds (**Door Open**). Feed it from any door sensor (e.g. Aqara) with two Home automations: sensor opens → turn the switch on; sensor closes → turn it off.
- The lock never locks while the door is open. When the door closes while unlocked, it locks after the Matter auto-relock time set in Home, or after `lockAfterCloseSeconds` if set.

Enable it under **Matter door lock** in the plugin settings, restart, and pair it in Home with the code printed in the log (Add Accessory → More options). The plugin logs what Home writes to the lock (e.g. `autoRelockTime`).

Note: Apple may show Lock After Closing only for certain locks; this is experimental. The lock appears in Home next to the Nuki's own Matter lock.

## Event format (Nuki MQTT API v1.6)
`LockAction,Trigger,AuthID,CodeID,KeypadSource` — keypad source `1` = code, `2` = fingerprint.

## Support
If this plugin helps you: https://paypal.me/orenasher
