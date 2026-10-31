def count_down(depth)
  return 0 if depth.zero?
  count_down(depth - 1) + 1
end

def count_down_with_block(depth)
  return 0 if depth.zero?
  [depth - 1].map { |next_depth| count_down_with_block(next_depth) }.first + 1
end

def count_down_with_each(depth)
  return 0 if depth.zero?
  result = 0
  [depth - 1].each { |next_depth| result = count_down_with_each(next_depth) + 1 }
  result
end
