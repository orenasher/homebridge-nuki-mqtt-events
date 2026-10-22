# homebridge-nuki-mqtt-events

Momentary HomeKit switches that turn **on for ~1 second** whenever a Nuki Smart Lock is opened from the Keypad 2 by **fingerprint** or **code**, using the Nuki local MQTT API (`nuki/<ID>/lockActionEvent`).

Typical use: an Apple Home automation *"When Nuki Fingerprint turns on → set Security System to Off"* — so the alarm is disarmed only by fingerprint/code, never when the door is opened from inside or from the app.

## Requirements
- Nuki Smart Lock with MQTT enabled in the Nuki app (Features & Configuration → Smart Home → MQTT)
- An MQTT broker (e.g. Home Assistant's Mosquitto add-on)

## Config
```json
{
  "platform": "NukiMqttEvents",
  "host": "10.167.175.232",
  "port": 1883,
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
