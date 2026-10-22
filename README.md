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

## Event format (Nuki MQTT API v1.6)
`LockAction,Trigger,AuthID,CodeID,KeypadSource` — keypad source `1` = code, `2` = fingerprint.

## Support
If this plugin helps you: https://paypal.me/orenasher
