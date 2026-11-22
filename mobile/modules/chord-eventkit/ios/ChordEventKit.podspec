Pod::Spec.new do |s|
  s.name           = 'ChordEventKit'
  s.version        = '1.0.0'
  s.summary        = 'Reads EventKit calendarItemExternalIdentifier (ADR 0057).'
  s.description    = 'Surfaces the calendar-server UID expo-calendar omits, for device-calendar dedup.'
  s.author         = 'Chord'
  s.homepage       = 'https://chordapp.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
